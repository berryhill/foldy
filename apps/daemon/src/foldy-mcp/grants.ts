import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const FOLDY_MCP_SCOPES = ['read', 'editor', 'reviewer', 'publisher', 'deployer'] as const;
export type FoldyMcpScope = typeof FOLDY_MCP_SCOPES[number];

export interface FoldyMcpGrant {
  grantId: string;
  projectId: string;
  scopes: FoldyMcpScope[];
  createdAt: string;
  revokedAt: string | null;
}

interface PersistedGrant extends FoldyMcpGrant { tokenSha256: string }
interface PersistedState { schemaVersion: 1; grants: PersistedGrant[] }

export interface FoldyMcpGrantStore {
  create(input: { projectId: string; scopes: readonly string[] }): Promise<{ grant: FoldyMcpGrant; token: string }>;
  list(projectId?: string): FoldyMcpGrant[];
  get(grantId: string): FoldyMcpGrant | null;
  authenticate(token: string, projectId?: string, scope?: FoldyMcpScope): FoldyMcpGrant | null;
  revoke(grantId: string): Promise<FoldyMcpGrant | null>;
}

const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const publicGrant = ({ tokenSha256: _hash, ...grant }: PersistedGrant): FoldyMcpGrant => ({ ...grant, scopes: [...grant.scopes] });

function normalizedScopes(input: readonly string[]): FoldyMcpScope[] {
  const supplied = new Set(input);
  if (supplied.size === 0 || [...supplied].some((scope) => !FOLDY_MCP_SCOPES.includes(scope as FoldyMcpScope))) {
    throw new RangeError(`scopes must contain one or more of: ${FOLDY_MCP_SCOPES.join(', ')}`);
  }
  return FOLDY_MCP_SCOPES.filter((scope) => supplied.has(scope));
}

function parseState(value: unknown): PersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Foldy MCP grant state is corrupt');
  const candidate = value as Partial<PersistedState>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.grants)) throw new Error('Foldy MCP grant state is corrupt');
  for (const grant of candidate.grants) {
    if (!grant || typeof grant !== 'object' || typeof grant.grantId !== 'string' || typeof grant.projectId !== 'string'
      || !Array.isArray(grant.scopes) || grant.scopes.length === 0 || grant.scopes.some((scope) => !FOLDY_MCP_SCOPES.includes(scope))
      || typeof grant.tokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(grant.tokenSha256)
      || typeof grant.createdAt !== 'string' || (grant.revokedAt !== null && typeof grant.revokedAt !== 'string')) {
      throw new Error('Foldy MCP grant state is corrupt');
    }
  }
  return candidate as PersistedState;
}

export async function createFoldyMcpGrantStore(options: {
  dataRoot: string;
  randomToken?: () => string;
  randomId?: () => string;
  now?: () => Date;
}): Promise<FoldyMcpGrantStore> {
  if (!path.isAbsolute(options.dataRoot)) throw new Error('Foldy MCP dataRoot must be absolute');
  const directory = path.join(options.dataRoot, 'foldy-mcp');
  const statePath = path.join(directory, 'grants.json');
  let state: PersistedState;
  try { state = parseState(JSON.parse(await readFile(statePath, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { schemaVersion: 1, grants: [] };
  }
  const randomToken = options.randomToken ?? (() => `odfmcp_${randomBytes(32).toString('base64url')}`);
  const randomId = options.randomId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  let mutation = Promise.resolve();

  const persist = async (): Promise<void> => {
    const snapshot = JSON.stringify(state, null, 2) + '\n';
    const task = mutation.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = path.join(directory, `.grants.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, statePath);
        await chmod(statePath, 0o600);
      } finally { await rm(temporary, { force: true }); }
    });
    mutation = task.catch(() => undefined);
    await task;
  };

  return {
    async create(input) {
      if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) throw new RangeError('projectId is required');
      const token = randomToken();
      if (!token) throw new Error('token generator returned an empty token');
      const grant: PersistedGrant = {
        grantId: randomId(), projectId: input.projectId, scopes: normalizedScopes(input.scopes),
        createdAt: now().toISOString(), revokedAt: null, tokenSha256: digest(token),
      };
      state.grants.push(grant);
      await persist();
      return { grant: publicGrant(grant), token };
    },
    list(projectId) { return state.grants.filter((grant) => !projectId || grant.projectId === projectId).map(publicGrant); },
    get(grantId) { const grant = state.grants.find((item) => item.grantId === grantId); return grant ? publicGrant(grant) : null; },
    authenticate(token, projectId, scope) {
      if (typeof token !== 'string' || token.length === 0) return null;
      const supplied = Buffer.from(digest(token), 'hex');
      const grant = state.grants.find((item) => item.revokedAt === null
        && (!projectId || item.projectId === projectId) && (!scope || item.scopes.includes(scope))
        && timingSafeEqual(Buffer.from(item.tokenSha256, 'hex'), supplied));
      return grant ? publicGrant(grant) : null;
    },
    async revoke(grantId) {
      const grant = state.grants.find((item) => item.grantId === grantId);
      if (!grant) return null;
      if (!grant.revokedAt) { grant.revokedAt = now().toISOString(); await persist(); }
      return publicGrant(grant);
    },
  };
}
