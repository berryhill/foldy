import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FoldyDeploymentMcpGrantDescriptor } from '@open-design/contracts';

export const FOLDY_MCP_SCOPES = ['read', 'editor', 'reviewer', 'publisher', 'deployer'] as const;
export type FoldyMcpScope = typeof FOLDY_MCP_SCOPES[number];
export type FoldyMcpRemoteRevocationStatus = 'pending' | 'complete';

export interface FoldyMcpGrant {
  grantId: string;
  projectId: string;
  scopes: FoldyMcpScope[];
  createdAt: string;
  revokedAt: string | null;
  revocationStatus: FoldyMcpRemoteRevocationStatus | null;
}

interface PersistedGrant {
  grantId: string;
  projectId: string;
  scopes: FoldyMcpScope[];
  createdAt: string;
  revokedAt: string | null;
  tokenSha256: string;
}
export interface FoldyMcpRemoteRevocationIntent {
  grantId: string;
  projectId: string;
  tokenSha256: string;
  status: FoldyMcpRemoteRevocationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
}
interface PersistedStateV1 { schemaVersion: 1; grants: PersistedGrant[] }
interface PersistedState { schemaVersion: 2; grants: PersistedGrant[]; remoteRevocations: FoldyMcpRemoteRevocationIntent[] }

export interface FoldyMcpGrantStore {
  create(input: { projectId: string; scopes: readonly string[] }): Promise<{ grant: FoldyMcpGrant; token: string }>;
  list(projectId?: string): FoldyMcpGrant[];
  get(grantId: string): FoldyMcpGrant | null;
  authenticate(token: string, projectId?: string, scope?: FoldyMcpScope): FoldyMcpGrant | null;
  deploymentDescriptor(grantId: string, projectId: string): FoldyDeploymentMcpGrantDescriptor | null;
  isCurrentDeploymentDescriptor(projectId: string, descriptor: FoldyDeploymentMcpGrantDescriptor): boolean;
  revoke(grantId: string): Promise<FoldyMcpGrant | null>;
  pendingRevocations(limit?: number): FoldyMcpRemoteRevocationIntent[];
  recordRevocationAttempt(grantId: string, result: { status: FoldyMcpRemoteRevocationStatus; errorCode?: string }): Promise<FoldyMcpRemoteRevocationIntent | null>;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[A-Z0-9_]{1,96}$/;
const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const cloneState = (state: PersistedState): PersistedState => ({
  schemaVersion: 2,
  grants: state.grants.map((grant) => ({ ...grant, scopes: [...grant.scopes] })),
  remoteRevocations: state.remoteRevocations.map((intent) => ({ ...intent })),
});
const cloneIntent = (intent: FoldyMcpRemoteRevocationIntent): FoldyMcpRemoteRevocationIntent => ({ ...intent });

function publicGrant(state: PersistedState, grant: PersistedGrant): FoldyMcpGrant {
  const intent = state.remoteRevocations.find((item) => item.grantId === grant.grantId);
  return {
    grantId: grant.grantId,
    projectId: grant.projectId,
    scopes: [...grant.scopes],
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
    revocationStatus: grant.revokedAt === null ? null : intent?.status ?? 'pending',
  };
}

function normalizedScopes(input: readonly string[]): FoldyMcpScope[] {
  const supplied = new Set(input);
  if (supplied.size === 0 || [...supplied].some((scope) => !FOLDY_MCP_SCOPES.includes(scope as FoldyMcpScope))) {
    throw new RangeError(`scopes must contain one or more of: ${FOLDY_MCP_SCOPES.join(', ')}`);
  }
  return FOLDY_MCP_SCOPES.filter((scope) => supplied.has(scope));
}

function validGrant(grant: unknown): grant is PersistedGrant {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return false;
  const value = grant as Partial<PersistedGrant>;
  return typeof value.grantId === 'string' && typeof value.projectId === 'string'
    && Array.isArray(value.scopes) && value.scopes.length > 0
    && value.scopes.every((scope) => FOLDY_MCP_SCOPES.includes(scope))
    && typeof value.tokenSha256 === 'string' && DIGEST.test(value.tokenSha256)
    && typeof value.createdAt === 'string'
    && (value.revokedAt === null || typeof value.revokedAt === 'string');
}

function validIntent(intent: unknown): intent is FoldyMcpRemoteRevocationIntent {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return false;
  const value = intent as Partial<FoldyMcpRemoteRevocationIntent>;
  return typeof value.grantId === 'string' && typeof value.projectId === 'string'
    && typeof value.tokenSha256 === 'string' && DIGEST.test(value.tokenSha256)
    && (value.status === 'pending' || value.status === 'complete')
    && Number.isSafeInteger(value.attempts) && (value.attempts ?? -1) >= 0
    && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
    && (value.lastAttemptAt === null || typeof value.lastAttemptAt === 'string')
    && (value.completedAt === null || typeof value.completedAt === 'string')
    && (value.lastErrorCode === null || (typeof value.lastErrorCode === 'string' && ERROR_CODE.test(value.lastErrorCode)));
}

function parseState(value: unknown): { state: PersistedState; migrated: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Foldy MCP grant state is corrupt');
  const candidate = value as { schemaVersion?: unknown; grants?: unknown; remoteRevocations?: unknown };
  if (!Array.isArray(candidate.grants) || !candidate.grants.every(validGrant)) throw new Error('Foldy MCP grant state is corrupt');
  const grants = candidate.grants as PersistedGrant[];
  if (candidate.schemaVersion === 1) {
    const migratedGrants = grants.map((grant) => ({ ...grant, scopes: [...grant.scopes] }));
    return {
      migrated: true,
      state: {
        schemaVersion: 2,
        grants: migratedGrants,
        remoteRevocations: migratedGrants.filter((grant) => grant.revokedAt !== null).map((grant) => ({
          grantId: grant.grantId,
          projectId: grant.projectId,
          tokenSha256: grant.tokenSha256,
          status: 'pending',
          attempts: 0,
          createdAt: grant.revokedAt!,
          updatedAt: grant.revokedAt!,
          lastAttemptAt: null,
          completedAt: null,
          lastErrorCode: null,
        })),
      },
    };
  }
  if (candidate.schemaVersion !== 2 || !Array.isArray(candidate.remoteRevocations)
    || !candidate.remoteRevocations.every(validIntent)) throw new Error('Foldy MCP grant state is corrupt');
  const state = cloneState(candidate as PersistedState);
  const grantIds = new Set(state.grants.map((grant) => grant.grantId));
  if (new Set(state.remoteRevocations.map((intent) => intent.grantId)).size !== state.remoteRevocations.length
    || state.remoteRevocations.some((intent) => !grantIds.has(intent.grantId))) throw new Error('Foldy MCP grant state is corrupt');
  return { state, migrated: false };
}

async function atomicWrite(directory: string, statePath: string, snapshot: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.grants.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(snapshot, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, statePath);
    await chmod(statePath, 0o600);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function createFoldyMcpGrantStore(options: {
  dataRoot: string;
  randomToken?: () => string;
  randomId?: () => string;
  now?: () => Date;
  /** Test seam around the production atomic writer. */
  persistState?: (persist: () => Promise<void>) => Promise<void>;
}): Promise<FoldyMcpGrantStore> {
  if (!path.isAbsolute(options.dataRoot)) throw new Error('Foldy MCP dataRoot must be absolute');
  const directory = path.join(options.dataRoot, 'foldy-mcp');
  const statePath = path.join(directory, 'grants.json');
  let state: PersistedState;
  let migrated = false;
  try {
    const parsed = parseState(JSON.parse(await readFile(statePath, 'utf8')));
    state = parsed.state;
    migrated = parsed.migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { schemaVersion: 2, grants: [], remoteRevocations: [] };
  }
  const randomToken = options.randomToken ?? (() => `odfmcp_${randomBytes(32).toString('base64url')}`);
  const randomId = options.randomId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const persistState = options.persistState ?? (async (persist) => persist());
  let mutation = Promise.resolve();

  const persist = async (candidate: PersistedState): Promise<void> => {
    const snapshot = JSON.stringify(candidate, null, 2) + '\n';
    await persistState(() => atomicWrite(directory, statePath, snapshot));
  };
  const mutate = async <T>(change: (candidate: PersistedState) => T): Promise<T> => {
    let result!: T;
    const task = mutation.then(async () => {
      const candidate = cloneState(state);
      result = change(candidate);
      await persist(candidate);
      state = candidate;
    });
    mutation = task.catch(() => undefined);
    await task;
    return result;
  };

  if (migrated) await persist(state);

  return {
    async create(input) {
      if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) throw new RangeError('projectId is required');
      const token = randomToken();
      if (!token) throw new Error('token generator returned an empty token');
      const grant: PersistedGrant = {
        grantId: randomId(), projectId: input.projectId, scopes: normalizedScopes(input.scopes),
        createdAt: now().toISOString(), revokedAt: null, tokenSha256: digest(token),
      };
      await mutate((candidate) => { candidate.grants.push({ ...grant, scopes: [...grant.scopes] }); });
      return { grant: publicGrant(state, grant), token };
    },
    list(projectId) {
      return state.grants.filter((grant) => !projectId || grant.projectId === projectId).map((grant) => publicGrant(state, grant));
    },
    get(grantId) {
      const grant = state.grants.find((item) => item.grantId === grantId);
      return grant ? publicGrant(state, grant) : null;
    },
    authenticate(token, projectId, scope) {
      if (typeof token !== 'string' || token.length === 0) return null;
      const supplied = Buffer.from(digest(token), 'hex');
      const grant = state.grants.find((item) => item.revokedAt === null
        && (!projectId || item.projectId === projectId) && (!scope || item.scopes.includes(scope))
        && timingSafeEqual(Buffer.from(item.tokenSha256, 'hex'), supplied));
      return grant ? publicGrant(state, grant) : null;
    },
    deploymentDescriptor(grantId, projectId) {
      const grant = state.grants.find((item) => item.grantId === grantId
        && item.projectId === projectId && item.revokedAt === null);
      return grant ? { grantId: grant.grantId, scopes: [...grant.scopes], tokenSha256: grant.tokenSha256 } : null;
    },
    isCurrentDeploymentDescriptor(projectId, descriptor) {
      const current = state.grants.find((item) => item.grantId === descriptor.grantId
        && item.projectId === projectId && item.revokedAt === null);
      return Boolean(current
        && current.tokenSha256 === descriptor.tokenSha256
        && current.scopes.length === descriptor.scopes.length
        && current.scopes.every((scope, index) => scope === descriptor.scopes[index]));
    },
    async revoke(grantId) {
      if (!state.grants.some((item) => item.grantId === grantId)) return null;
      await mutate((candidate) => {
        const grant = candidate.grants.find((item) => item.grantId === grantId)!;
        if (grant.revokedAt === null) grant.revokedAt = now().toISOString();
        if (!candidate.remoteRevocations.some((item) => item.grantId === grantId)) {
          candidate.remoteRevocations.push({
            grantId: grant.grantId,
            projectId: grant.projectId,
            tokenSha256: grant.tokenSha256,
            status: 'pending',
            attempts: 0,
            createdAt: grant.revokedAt,
            updatedAt: grant.revokedAt,
            lastAttemptAt: null,
            completedAt: null,
            lastErrorCode: null,
          });
        }
      });
      const current = state.grants.find((item) => item.grantId === grantId);
      return current ? publicGrant(state, current) : null;
    },
    pendingRevocations(limit = Number.MAX_SAFE_INTEGER) {
      const bounded = Number.isSafeInteger(limit) && limit >= 0 ? limit : 0;
      return state.remoteRevocations.filter((intent) => intent.status === 'pending').slice(0, bounded).map(cloneIntent);
    },
    async recordRevocationAttempt(grantId, result) {
      const existing = state.remoteRevocations.find((item) => item.grantId === grantId);
      if (!existing || existing.status === 'complete') return existing ? cloneIntent(existing) : null;
      const at = now().toISOString();
      let updated: FoldyMcpRemoteRevocationIntent | null = null;
      await mutate((candidate) => {
        const intent = candidate.remoteRevocations.find((item) => item.grantId === grantId)!;
        intent.attempts += 1;
        intent.status = result.status;
        intent.updatedAt = at;
        intent.lastAttemptAt = at;
        intent.completedAt = result.status === 'complete' ? at : null;
        intent.lastErrorCode = result.status === 'complete' ? null
          : (result.errorCode && ERROR_CODE.test(result.errorCode) ? result.errorCode : 'PROVIDER_REVOKE_FAILED');
        updated = cloneIntent(intent);
      });
      return updated;
    },
  };
}
