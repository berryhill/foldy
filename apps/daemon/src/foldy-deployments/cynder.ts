import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type {
  FoldyDeploymentAccessMode,
  FoldyDeploymentAccessPolicy,
  FoldyDeploymentBinding,
  FoldyDeploymentMcpGrantDescriptor,
} from '@open-design/contracts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export type CynderDeploymentStatus = 'staged' | 'active' | 'rolled_back' | 'failed' | 'rollback_failed';
export interface FoldyRevisionManifest { revisionId: string; entryFile: string; bundleSha256: string; files: { path: string; sha256: string; size: number }[] }
export interface CynderBundleFile { path: string; sha256: string; bytesBase64: string }
export interface CynderDeploymentBinding extends FoldyDeploymentBinding {}
export interface CynderPreflight { accepted: boolean; details?: Record<string, unknown> }
export interface CynderHealthResult { checks: { name: string; ok: boolean; status?: number }[] }
interface CynderProvisioningInput {
  accessPolicy: FoldyDeploymentAccessPolicy;
  mcpGrant: FoldyDeploymentMcpGrantDescriptor;
}
interface CynderRollbackTarget extends CynderProvisioningInput {
  binding: CynderDeploymentBinding;
}
export interface CynderDeploymentAdapter {
  preflight(input: { projectId: string; revisionId: string; bundleSha256: string; environment: string; idempotencyKey: string; entryFile: string; declaredRoutes: string[] } & CynderProvisioningInput): Promise<CynderPreflight>;
  deployImmutable(input: { projectId: string; revisionId: string; bundleSha256: string; environment: string; idempotencyKey: string; entryFile: string; files: CynderBundleFile[] } & CynderProvisioningInput): Promise<CynderDeploymentBinding>;
  activate(input: { binding: CynderDeploymentBinding; expectedProviderRevisionId: string | null; idempotencyKey: string }): Promise<void>;
  inspect(input: { projectId: string; environment: string }): Promise<CynderDeploymentBinding | null>;
  verifyHealth(input: { binding: CynderDeploymentBinding; entryFile: string; declaredRoutes: string[] }): Promise<CynderHealthResult>;
  /** Idempotently removes the project-bound digest from the provider authorization plane. */
  revokeMcpGrant(input: McpGrantRevocationInput): Promise<void>;
  rollback(input: {
    projectId: string;
    environment: string;
    failed: CynderDeploymentBinding | null;
    restore: CynderDeploymentBinding | null;
    /** Provider must compare-and-swap this exact active revision atomically with rollback. */
    expectedActiveProviderRevisionId: string | null;
    idempotencyKey: string;
  }): Promise<void>;
}
export interface McpGrantRevocationInput {
  grantId: string;
  tokenSha256: string;
  projectId: string;
}
function isForbiddenDeploymentHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    const a = octets[0] ?? 0; const b = octets[1] ?? 0;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(host) === 6) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('::ffff:')) return true;
    const first = Number.parseInt(host.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
  }
  return false;
}
export interface CynderDeploymentReceipt {
  schemaVersion: 1 | 2; receiptId: string; kind: 'deploy' | 'rollback'; status: CynderDeploymentStatus;
  recoverable: boolean;
  projectId: string; revisionId: string; bundleSha256: string; environment: string; idempotencyKey: string;
  accessPolicy: FoldyDeploymentAccessPolicy | null; mcpGrant: FoldyDeploymentMcpGrantDescriptor | null;
  expectedActiveProviderRevisionId: string | null; priorActive: CynderDeploymentBinding | null; binding: CynderDeploymentBinding | null;
  health: CynderHealthResult | null; createdAt: string; completedAt: string | null; errorCode?: string; rollbackError?: string;
}
export interface CynderDeploymentStatusSnapshot {
  binding: CynderDeploymentBinding | null;
  completed: CynderDeploymentReceipt[];
  staged: CynderDeploymentReceipt[];
}
export interface CynderRecoveryInput { projectId: string; environment: string; receiptId?: string }
export class CynderDeploymentError extends Error {
  rollbackFailed?: boolean;
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); this.name = 'CynderDeploymentError'; }
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameBinding = (left: CynderDeploymentBinding | null, right: CynderDeploymentBinding | null): boolean =>
  left !== null && right !== null
  && left.providerDeploymentId === right.providerDeploymentId
  && left.providerRevisionId === right.providerRevisionId
  && left.projectId === right.projectId
  && left.revisionId === right.revisionId
  && left.bundleSha256 === right.bundleSha256
  && left.environment === right.environment
  && left.url === right.url
  && left.mcpUrl === right.mcpUrl
  && left.accessMode === right.accessMode;
const sameOptionalBinding = (left: CynderDeploymentBinding | null, right: CynderDeploymentBinding | null): boolean =>
  (left === null && right === null) || sameBinding(left, right);
const sameProvisioning = (left: CynderProvisioningInput, right: CynderProvisioningInput): boolean =>
  left.accessPolicy.mode === right.accessPolicy.mode
  && (left.accessPolicy.mode !== 'password_required' || (right.accessPolicy.mode === 'password_required' && left.accessPolicy.passwordScryptVerifier === right.accessPolicy.passwordScryptVerifier))
  && left.mcpGrant.grantId === right.mcpGrant.grantId
  && left.mcpGrant.tokenSha256 === right.mcpGrant.tokenSha256
  && left.mcpGrant.scopes.length === right.mcpGrant.scopes.length
  && left.mcpGrant.scopes.every((scope, index) => scope === right.mcpGrant.scopes[index]);
function isValidId(value: unknown, pattern = ID): value is string {
  return typeof value === 'string' && pattern.test(value) && value !== '.' && value !== '..';
}
function validId(value: string, field: string, pattern = ID): void {
  if (!isValidId(value, pattern)) throw new CynderDeploymentError(400, 'FOLDY_CYNDER_INVALID_REQUEST', `invalid ${field}`);
}
function assertProviderBindingIdentity(binding: unknown): asserts binding is CynderDeploymentBinding {
  if (!isRecord(binding) || !isValidId(binding.providerDeploymentId) || !isValidId(binding.providerRevisionId)) {
    throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_MISMATCH', 'provider response returned an invalid deployment or revision identity');
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function decodeAccessPolicy(value: unknown): FoldyDeploymentAccessPolicy | null {
  if (!isRecord(value)) return null;
  if (value.mode === 'public') return { mode: 'public' };
  if (value.mode === 'password_required' && typeof value.passwordScryptVerifier === 'string'
    && /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(value.passwordScryptVerifier)) {
    return { mode: 'password_required', passwordScryptVerifier: value.passwordScryptVerifier };
  }
  return null;
}
function decodeMcpGrant(value: unknown): FoldyDeploymentMcpGrantDescriptor | null {
  if (!isRecord(value) || typeof value.grantId !== 'string' || !ID.test(value.grantId)
    || typeof value.tokenSha256 !== 'string' || !DIGEST.test(value.tokenSha256)
    || !Array.isArray(value.scopes) || value.scopes.length === 0
    || !value.scopes.every((scope) => ['read', 'editor', 'reviewer', 'publisher', 'deployer'].includes(String(scope)))) return null;
  return { grantId: value.grantId, tokenSha256: value.tokenSha256, scopes: [...value.scopes] as FoldyDeploymentMcpGrantDescriptor['scopes'] };
}
function decodeBinding(value: unknown): CynderDeploymentBinding | null {
  if (!isRecord(value)) return null;
  const fields = ['providerDeploymentId', 'providerRevisionId', 'projectId', 'revisionId', 'bundleSha256', 'environment', 'url', 'mcpUrl'] as const;
  if (!fields.every((field) => typeof value[field] === 'string')
    || !isValidId(value.providerDeploymentId) || !isValidId(value.providerRevisionId)
    || (value.accessMode !== 'public' && value.accessMode !== 'password_required')) return null;
  return value as unknown as CynderDeploymentBinding;
}
function decodeReceipt(value: unknown): CynderDeploymentReceipt | null {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || typeof value.receiptId !== 'string' || !ID.test(value.receiptId)
    || (value.kind !== 'deploy' && value.kind !== 'rollback')
    || !['staged', 'active', 'rolled_back', 'failed', 'rollback_failed'].includes(String(value.status))
    || typeof value.projectId !== 'string' || typeof value.revisionId !== 'string' || typeof value.bundleSha256 !== 'string'
    || typeof value.environment !== 'string' || typeof value.idempotencyKey !== 'string' || typeof value.createdAt !== 'string') return null;
  const accessPolicy = decodeAccessPolicy(value.accessPolicy);
  const mcpGrant = decodeMcpGrant(value.mcpGrant);
  if (value.schemaVersion === 2 && (!accessPolicy || !mcpGrant)) return null;
  const status = value.status as CynderDeploymentStatus;
  return {
    ...(value as unknown as CynderDeploymentReceipt),
    accessPolicy,
    mcpGrant,
    binding: decodeBinding(value.binding),
    priorActive: decodeBinding(value.priorActive),
    recoverable: value.schemaVersion === 2 && status === 'staged' && accessPolicy !== null && mcpGrant !== null,
  };
}
function errorOf(error: unknown): CynderDeploymentError { return error instanceof CynderDeploymentError ? error : new CynderDeploymentError(502, 'FOLDY_CYNDER_PROVIDER_FAILED', 'Cynder provider operation failed'); }
function canonicalRequest(input: DeploymentBaseInput, bundleSha256: string, kind: 'deploy' | 'rollback', provisioning?: CynderProvisioningInput): string {
  const canonicalProvisioning = kind === 'deploy' && provisioning
    ? {
        accessPolicy: provisioning.accessPolicy.mode === 'password_required'
          ? { mode: 'password_required' as const, passwordScryptVerifier: provisioning.accessPolicy.passwordScryptVerifier }
          : { mode: 'public' as const },
        mcpGrant: {
          grantId: provisioning.mcpGrant.grantId,
          scopes: [...provisioning.mcpGrant.scopes],
          tokenSha256: provisioning.mcpGrant.tokenSha256,
        },
      }
    : undefined;
  return JSON.stringify({
    kind,
    projectId: input.projectId,
    revisionId: input.revisionId,
    bundleSha256,
    environment: input.environment,
    idempotencyKey: input.idempotencyKey,
    expectedActiveProviderRevisionId: input.expectedActiveProviderRevisionId,
    ...(canonicalProvisioning ?? {}),
  });
}
async function atomicJson(directory: string, target: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, target); await chmod(target, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
interface DeploymentBaseInput { projectId: string; revisionId: string; environment: string; idempotencyKey: string; expectedActiveProviderRevisionId: string | null }
export interface DeploymentInput extends DeploymentBaseInput, CynderProvisioningInput {}
export interface RollbackDeploymentInput extends DeploymentBaseInput {}
interface ServiceOptions {
  dataRoot: string; adapter: CynderDeploymentAdapter; now?: () => Date;
  getRevision(projectId: string, revisionId: string): Promise<FoldyRevisionManifest>;
  readRevisionFile(projectId: string, revisionId: string, file: string): Promise<Buffer>;
  isRevisionApproved(projectId: string, revisionId: string): boolean | Promise<boolean>;
  isCurrentMcpGrant(projectId: string, descriptor: FoldyDeploymentMcpGrantDescriptor): boolean | Promise<boolean>;
}
export class FoldyCynderDeploymentService {
  private readonly root: string; private readonly now: () => Date; private locks = new Map<string, Promise<void>>();
  constructor(private readonly options: ServiceOptions) { if (!path.isAbsolute(options.dataRoot)) throw new Error('dataRoot must be absolute'); this.root = path.join(options.dataRoot, 'foldy-deployments'); this.now = options.now ?? (() => new Date()); }
  deploy(input: DeploymentInput): Promise<CynderDeploymentReceipt> { return this.run(input, 'deploy'); }
  rollback(input: RollbackDeploymentInput): Promise<CynderDeploymentReceipt> { return this.run(input, 'rollback'); }
  async getStatus(projectId: string, environment: string): Promise<CynderDeploymentStatusSnapshot> {
    validId(projectId, 'projectId'); validId(environment, 'environment', ENVIRONMENT);
    const [binding, completed, staged] = await Promise.all([
      this.options.adapter.inspect({ projectId, environment }),
      this.readReceipts('receipts', projectId, environment),
      this.readReceipts('staged', projectId, environment),
    ]);
    return { binding: clone(binding), completed, staged };
  }
  recover(input: CynderRecoveryInput): Promise<CynderDeploymentReceipt> {
    validId(input.projectId, 'projectId'); validId(input.environment, 'environment', ENVIRONMENT);
    if (input.receiptId !== undefined) validId(input.receiptId, 'receiptId');
    return this.withMutationLock(input.projectId, input.environment, () => this.recoverLocked(input));
  }
  revokeMcpGrant(input: McpGrantRevocationInput): Promise<void> { return this.options.adapter.revokeMcpGrant(input); }
  private async readReceipts(directory: 'receipts' | 'staged', projectId?: string, environment?: string): Promise<CynderDeploymentReceipt[]> {
    const target = path.join(this.root, directory); let files: string[];
    try { files = await readdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const receipts: CynderDeploymentReceipt[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const receipt = decodeReceipt(JSON.parse(await readFile(path.join(target, file), 'utf8')));
        if (!receipt) continue;
        if (projectId !== undefined && receipt.projectId !== projectId) continue;
        if (environment !== undefined && receipt.environment !== environment) continue;
        receipts.push(clone(receipt));
      } catch { /* Ignore malformed siblings; they are never recoverable exact attempts. */ }
    }
    return receipts.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.receiptId.localeCompare(left.receiptId));
  }
  private async withMutationLock<T>(projectId: string, environment: string, operation: () => Promise<T>): Promise<T> {
    const mutationKey = hash(`${projectId}\0${environment}`);
    const previous = this.locks.get(mutationKey) ?? Promise.resolve(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const queued = previous.then(() => gate);
    this.locks.set(mutationKey, queued); await previous;
    try { return await operation(); } finally { release(); if (this.locks.get(mutationKey) === queued) this.locks.delete(mutationKey); }
  }
  private async run(input: DeploymentInput | RollbackDeploymentInput, kind: 'deploy' | 'rollback'): Promise<CynderDeploymentReceipt> {
    this.validateBase(input);
    if (kind === 'deploy') this.validateProvisioning(input as DeploymentInput);
    const idempotencyKey = hash(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`);
    return this.withMutationLock(input.projectId, input.environment, () => this.runLocked(input, kind, idempotencyKey));
  }
  private async recoverLocked(input: CynderRecoveryInput): Promise<CynderDeploymentReceipt> {
    const all = await this.readReceipts('staged');
    let matches: CynderDeploymentReceipt[];
    if (input.receiptId !== undefined) {
      const identified = all.filter((receipt) => receipt.receiptId === input.receiptId);
      if (identified.length === 0) throw new CynderDeploymentError(404, 'FOLDY_CYNDER_RECOVERY_NOT_FOUND', 'persisted staged Cynder attempt was not found');
      if (identified.some((receipt) => receipt.projectId !== input.projectId || receipt.environment !== input.environment)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_MISMATCH', 'persisted staged Cynder attempt does not match the requested project and environment');
      if (identified.some((receipt) => !receipt.recoverable)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_NOT_RECOVERABLE', 'persisted Cynder attempt is terminal, legacy, or lacks exact recovery evidence');
      matches = identified;
    } else matches = all.filter((receipt) => receipt.projectId === input.projectId && receipt.environment === input.environment && receipt.recoverable);
    if (matches.length === 0) throw new CynderDeploymentError(404, 'FOLDY_CYNDER_RECOVERY_NOT_FOUND', 'persisted staged Cynder attempt was not found');
    if (matches.length !== 1) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_AMBIGUOUS', 'multiple persisted staged Cynder attempts require an exact receiptId', { receiptIds: matches.map((receipt) => receipt.receiptId) });
    let receipt = matches[0]!;
    if (!receipt.accessPolicy || !receipt.mcpGrant) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_NOT_RECOVERABLE', 'persisted Cynder attempt lacks exact recovery evidence');
    const recoveryProvisioning: CynderProvisioningInput = { accessPolicy: receipt.accessPolicy, mcpGrant: receipt.mcpGrant };
    this.validateBase(receipt);
    this.validateProvisioning({ ...receipt, ...recoveryProvisioning });
    if (receipt.kind === 'deploy') {
      await this.assertRevisionApproved(receipt.projectId, receipt.revisionId);
      await this.assertCurrentGrant(receipt.projectId, recoveryProvisioning.mcpGrant);
    }
    const revision = await this.options.getRevision(receipt.projectId, receipt.revisionId);
    if (revision.revisionId !== receipt.revisionId || revision.bundleSha256 !== receipt.bundleSha256 || !DIGEST.test(revision.bundleSha256)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_REVISION_MISMATCH', 'persisted staged attempt no longer matches the immutable revision manifest');
    const key = hash(`${receipt.projectId}\0${receipt.environment}\0${receipt.idempotencyKey}`);
    const stagedDir = path.join(this.root, 'staged'); const stagedPath = path.join(stagedDir, `${key}.json`);
    const finalDir = path.join(this.root, 'receipts'); const finalPath = path.join(finalDir, `${receipt.receiptId}.json`);
    const declaredRoutes = revision.files.map((file) => file.path).filter((file) => file !== revision.entryFile && /\.html?$/i.test(file));
    const prior = receipt.priorActive; let deployed = receipt.binding;
    let active = await this.options.adapter.inspect({ projectId: receipt.projectId, environment: receipt.environment });
    try {
      if (receipt.kind === 'deploy') {
        if (!deployed) {
          if (!sameOptionalBinding(active, prior)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_ACTIVE_MISMATCH', 'provider binding does not match the staged attempt precondition');
          const preflight = await this.options.adapter.preflight({ projectId: receipt.projectId, revisionId: receipt.revisionId, bundleSha256: receipt.bundleSha256, environment: receipt.environment, idempotencyKey: receipt.receiptId, entryFile: revision.entryFile, declaredRoutes, accessPolicy: recoveryProvisioning.accessPolicy, mcpGrant: recoveryProvisioning.mcpGrant });
          if (!preflight.accepted) throw new CynderDeploymentError(422, 'FOLDY_CYNDER_PREFLIGHT_REJECTED', 'Cynder rejected deployment preflight', preflight.details);
          const files: CynderBundleFile[] = [];
          for (const file of revision.files) {
            const bytes = await this.options.readRevisionFile(receipt.projectId, receipt.revisionId, file.path);
            if (bytes.byteLength !== file.size || hash(bytes) !== file.sha256) throw new CynderDeploymentError(500, 'FOLDY_CYNDER_BUNDLE_MISMATCH', 'revision blob does not match immutable manifest');
            files.push({ path: file.path, sha256: file.sha256, bytesBase64: bytes.toString('base64') });
          }
          const candidate = await this.options.adapter.deployImmutable({ projectId: receipt.projectId, revisionId: receipt.revisionId, bundleSha256: receipt.bundleSha256, environment: receipt.environment, idempotencyKey: receipt.receiptId, entryFile: revision.entryFile, files, accessPolicy: recoveryProvisioning.accessPolicy, mcpGrant: recoveryProvisioning.mcpGrant });
          this.assertBinding(candidate, receipt, recoveryProvisioning.accessPolicy);
          deployed = candidate; receipt = { ...receipt, binding: deployed }; await atomicJson(stagedDir, stagedPath, receipt);
        }
        if (!sameBinding(active, deployed)) {
          if (!sameOptionalBinding(active, prior)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_ACTIVE_MISMATCH', 'provider binding changed outside the staged attempt');
          await this.options.adapter.activate({ binding: deployed, expectedProviderRevisionId: receipt.expectedActiveProviderRevisionId, idempotencyKey: receipt.receiptId });
        }
      } else {
        if (!deployed) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_BINDING_MISSING', 'staged rollback has no exact durable restore binding');
        if (!sameBinding(active, deployed)) {
          if (!sameOptionalBinding(active, prior)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_ACTIVE_MISMATCH', 'provider binding changed outside the staged rollback');
          await this.options.adapter.rollback({ projectId: receipt.projectId, environment: receipt.environment, failed: null, restore: deployed, expectedActiveProviderRevisionId: receipt.expectedActiveProviderRevisionId, idempotencyKey: receipt.receiptId });
        }
      }
      active = await this.options.adapter.inspect({ projectId: receipt.projectId, environment: receipt.environment });
      if (!sameBinding(active, deployed)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_RECOVERY_ACTIVE_MISMATCH', 'provider did not retain the exact staged binding');
      const health = await this.options.adapter.verifyHealth({ binding: deployed, entryFile: revision.entryFile, declaredRoutes });
      const completed: CynderDeploymentReceipt = { ...receipt, binding: deployed, health, recoverable: false, status: receipt.kind === 'rollback' ? 'rolled_back' : 'active', completedAt: this.now().toISOString() };
      await atomicJson(finalDir, finalPath, completed);
      await this.removeStagedReceiptCopies(receipt.receiptId);
      return clone(completed);
    } catch (failure) {
      const error = errorOf(failure);
      if (error.code.startsWith('FOLDY_CYNDER_RECOVERY_')) throw error;
      let rollbackError: string | undefined;
      if (deployed) {
        try {
          active = await this.options.adapter.inspect({ projectId: receipt.projectId, environment: receipt.environment });
          if (!sameBinding(active, deployed)) throw new Error('recovered deployment is no longer active');
          await this.options.adapter.rollback({ projectId: receipt.projectId, environment: receipt.environment, failed: deployed, restore: prior, expectedActiveProviderRevisionId: deployed.providerRevisionId, idempotencyKey: `${receipt.receiptId}:compensate` });
          const restored = await this.options.adapter.inspect({ projectId: receipt.projectId, environment: receipt.environment });
          if (!sameOptionalBinding(restored, prior)) throw new Error('recovery compensation did not restore exact prior binding');
        } catch { rollbackError = 'provider rollback failed or active binding changed'; error.rollbackFailed = true; }
      }
      const completed: CynderDeploymentReceipt = { ...receipt, binding: deployed, recoverable: false, status: rollbackError ? 'rollback_failed' : 'failed', completedAt: this.now().toISOString(), errorCode: error.code, ...(rollbackError ? { rollbackError } : {}) };
      await atomicJson(finalDir, finalPath, completed); await this.removeStagedReceiptCopies(receipt.receiptId); throw error;
    }
  }
  private async removeStagedReceiptCopies(receiptId: string): Promise<void> {
    const directory = path.join(this.root, 'staged');
    for (const file of await readdir(directory).catch(() => [])) {
      const candidate = path.join(directory, file);
      try { if ((JSON.parse(await readFile(candidate, 'utf8')) as CynderDeploymentReceipt).receiptId === receiptId) await rm(candidate, { force: true }); } catch { /* Ignore unrelated malformed files. */ }
    }
  }
  private assertBinding(binding: CynderDeploymentBinding, receipt: CynderDeploymentReceipt, accessPolicy: FoldyDeploymentAccessPolicy): void {
    assertProviderBindingIdentity(binding);
    if (binding.projectId !== receipt.projectId || binding.revisionId !== receipt.revisionId || binding.bundleSha256 !== receipt.bundleSha256 || binding.environment !== receipt.environment
      || typeof binding.url !== 'string' || binding.url.length === 0 || typeof binding.mcpUrl !== 'string' || binding.mcpUrl.length === 0 || binding.accessMode !== accessPolicy.mode) {
      throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_MISMATCH', 'provider response did not bind the exact revision, access policy, and MCP endpoint');
    }
  }
  private async runLocked(input: DeploymentInput | RollbackDeploymentInput, kind: 'deploy' | 'rollback', key: string): Promise<CynderDeploymentReceipt> {
    const revision = await this.options.getRevision(input.projectId, input.revisionId);
    if (revision.revisionId !== input.revisionId || !DIGEST.test(revision.bundleSha256)) throw new CynderDeploymentError(500, 'FOLDY_CYNDER_REVISION_INVALID', 'immutable revision manifest is invalid');
    const requestedProvisioning = kind === 'deploy' ? input as DeploymentInput : undefined;
    const canonical = canonicalRequest(input, revision.bundleSha256, kind, requestedProvisioning); const receiptId = `cynder-${hash(canonical).slice(0, 32)}`;
    const finalDir = path.join(this.root, 'receipts'); const finalPath = path.join(finalDir, receiptId + '.json');
    try {
      const found = decodeReceipt(JSON.parse(await readFile(finalPath, 'utf8')));
      if (!found || found.receiptId !== receiptId || canonicalRequest(found, found.bundleSha256, found.kind, found.accessPolicy && found.mcpGrant ? { accessPolicy: found.accessPolicy, mcpGrant: found.mcpGrant } : undefined) !== canonical) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_IDEMPOTENCY_CONFLICT', 'idempotency key was reused for a different deployment');
      return clone(found);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

    if (kind === 'deploy') {
      await this.assertRevisionApproved(input.projectId, input.revisionId);
      await this.assertCurrentGrant(input.projectId, requestedProvisioning!.mcpGrant);
    }

    const stagedDir = path.join(this.root, 'staged'); const stagedPath = path.join(stagedDir, key + '.json');
    try {
      const staged = decodeReceipt(JSON.parse(await readFile(stagedPath, 'utf8')));
      if (!staged || !staged.recoverable || canonicalRequest(staged, staged.bundleSha256, staged.kind, staged.accessPolicy && staged.mcpGrant ? { accessPolicy: staged.accessPolicy, mcpGrant: staged.mcpGrant } : undefined) !== canonical) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_IDEMPOTENCY_CONFLICT', 'idempotency key was reused for a different deployment');
      if (staged.binding
        && staged.binding.projectId === input.projectId && staged.binding.environment === input.environment
        && staged.binding.revisionId === input.revisionId && staged.binding.bundleSha256 === revision.bundleSha256) {
        const active = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
        if (sameBinding(active, staged.binding)) {
          const declaredRoutes = revision.files.map((file) => file.path).filter((file) => file !== revision.entryFile && /\.html?$/i.test(file));
          const health = staged.health ?? await this.options.adapter.verifyHealth({ binding: staged.binding, entryFile: revision.entryFile, declaredRoutes });
          const reconciled: CynderDeploymentReceipt = { ...staged, health, recoverable: false, status: staged.kind === 'rollback' ? 'rolled_back' : 'active', completedAt: this.now().toISOString() };
          await atomicJson(finalDir, finalPath, reconciled); await rm(stagedPath, { force: true }); return clone(reconciled);
        }
      }
      throw new CynderDeploymentError(409, 'FOLDY_CYNDER_INCOMPLETE_ATTEMPT', 'prior deployment attempt did not complete safely', { receiptId: staged.receiptId, status: staged.status });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

    const prior = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
    if ((prior?.providerRevisionId ?? null) !== input.expectedActiveProviderRevisionId) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ACTIVE_CONFLICT', 'active Cynder revision changed', { expected: input.expectedActiveProviderRevisionId, actual: prior?.providerRevisionId ?? null });
    const rollbackTarget = kind === 'rollback' ? await this.findRollbackBinding(input, revision) : null;
    const provisioning: CynderProvisioningInput = rollbackTarget ?? requestedProvisioning!;
    let receipt: CynderDeploymentReceipt = { schemaVersion: 2, receiptId, kind, status: 'staged', recoverable: true, projectId: input.projectId, revisionId: input.revisionId, bundleSha256: revision.bundleSha256, environment: input.environment, idempotencyKey: input.idempotencyKey, accessPolicy: clone(provisioning.accessPolicy), mcpGrant: clone(provisioning.mcpGrant), expectedActiveProviderRevisionId: input.expectedActiveProviderRevisionId, priorActive: prior, binding: kind === 'rollback' ? rollbackTarget!.binding : null, health: null, createdAt: this.now().toISOString(), completedAt: null };
    await atomicJson(stagedDir, stagedPath, receipt);
    let deployed: CynderDeploymentBinding | null = null;
    try {
      if (kind === 'rollback') {
        const restore = rollbackTarget?.binding;
        if (!restore) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ROLLBACK_BINDING_UNKNOWN', 'no durable provider binding exists for the requested rollback revision');
        await this.options.adapter.rollback({ projectId: input.projectId, environment: input.environment, failed: null, restore, expectedActiveProviderRevisionId: input.expectedActiveProviderRevisionId, idempotencyKey: receiptId });
        deployed = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
        if (!sameBinding(deployed, restore)) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_ROLLBACK_VERIFY_FAILED', 'provider did not activate the exact durable rollback binding');
        const declaredRoutes = revision.files.map((file) => file.path).filter((file) => file !== revision.entryFile && /\.html?$/i.test(file));
        receipt.health = await this.options.adapter.verifyHealth({ binding: restore, entryFile: revision.entryFile, declaredRoutes });
      } else {
        const deployInput = requestedProvisioning!;
        const declaredRoutes = revision.files.map((file) => file.path).filter((file) => file !== revision.entryFile && /\.html?$/i.test(file));
        const preflight = await this.options.adapter.preflight({ ...deployInput, idempotencyKey: receiptId, bundleSha256: revision.bundleSha256, entryFile: revision.entryFile, declaredRoutes });
        if (!preflight.accepted) throw new CynderDeploymentError(422, 'FOLDY_CYNDER_PREFLIGHT_REJECTED', 'Cynder rejected deployment preflight', preflight.details);
        const files: CynderBundleFile[] = [];
        for (const file of revision.files) { const bytes = await this.options.readRevisionFile(input.projectId, input.revisionId, file.path); if (bytes.byteLength !== file.size || hash(bytes) !== file.sha256) throw new CynderDeploymentError(500, 'FOLDY_CYNDER_BUNDLE_MISMATCH', 'revision blob does not match immutable manifest'); files.push({ path: file.path, sha256: file.sha256, bytesBase64: bytes.toString('base64') }); }
        const candidate = await this.options.adapter.deployImmutable({ ...deployInput, idempotencyKey: receiptId, bundleSha256: revision.bundleSha256, entryFile: revision.entryFile, files });
        this.assertBinding(candidate, receipt, deployInput.accessPolicy);
        deployed = candidate;
        receipt = { ...receipt, binding: deployed }; await atomicJson(stagedDir, stagedPath, receipt);
        await this.options.adapter.activate({ binding: deployed, expectedProviderRevisionId: input.expectedActiveProviderRevisionId, idempotencyKey: receiptId });
        const inspected = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
        if (!sameBinding(inspected, deployed)) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ACTIVE_CONFLICT', 'Cynder activation did not retain the exact deployed revision, access policy, and MCP endpoint');
        receipt.health = await this.options.adapter.verifyHealth({ binding: deployed, entryFile: revision.entryFile, declaredRoutes });
      }
      receipt = { ...receipt, binding: deployed, recoverable: false, status: kind === 'rollback' ? 'rolled_back' : 'active', completedAt: this.now().toISOString() }; await atomicJson(finalDir, finalPath, receipt); await rm(stagedPath, { force: true }); return clone(receipt);
    } catch (failure) {
      const error = errorOf(failure); let rollbackError: string | undefined;
      if (deployed) {
        try {
          const active = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
          if (!sameBinding(active, deployed)) throw new Error('failed deployment is no longer active');
          await this.options.adapter.rollback({ projectId: input.projectId, environment: input.environment, failed: deployed, restore: prior, expectedActiveProviderRevisionId: deployed.providerRevisionId, idempotencyKey: `${receiptId}:compensate` });
          const restored = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
          if (!sameOptionalBinding(restored, prior)) throw new Error('provider compensation did not restore the exact prior binding');
        } catch { rollbackError = 'provider rollback failed or active binding changed'; error.rollbackFailed = true; }
      }
      receipt = { ...receipt, binding: deployed, recoverable: false, status: rollbackError ? 'rollback_failed' : 'failed', completedAt: this.now().toISOString(), errorCode: error.code, ...(rollbackError ? { rollbackError } : {}) }; await atomicJson(stagedDir, stagedPath, receipt); throw error;
    }
  }
  private async findRollbackBinding(input: RollbackDeploymentInput, revision: FoldyRevisionManifest): Promise<CynderRollbackTarget> {
    const receiptsDir = path.join(this.root, 'receipts');
    let files: string[];
    try { files = await readdir(receiptsDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = []; else throw error; }
    const candidates: CynderRollbackTarget[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let receipt: CynderDeploymentReceipt | null;
      try { receipt = decodeReceipt(JSON.parse(await readFile(path.join(receiptsDir, file), 'utf8'))); }
      catch { continue; }
      if (!receipt) continue;
      const binding = receipt.binding;
      if (receipt.status === 'active' && binding
        && receipt.projectId === input.projectId && receipt.environment === input.environment
        && receipt.revisionId === input.revisionId && receipt.bundleSha256 === revision.bundleSha256
        && binding.projectId === input.projectId && binding.environment === input.environment
        && binding.revisionId === input.revisionId && binding.bundleSha256 === revision.bundleSha256
        && receipt.accessPolicy && receipt.mcpGrant) {
        candidates.push({ binding, accessPolicy: receipt.accessPolicy, mcpGrant: receipt.mcpGrant });
      }
    }
    const target = candidates[0];
    if (!target || candidates.some((candidate) => !sameBinding(candidate.binding, target.binding) || !sameProvisioning(candidate, target))) {
      throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ROLLBACK_BINDING_UNKNOWN', 'no unambiguous durable provider binding and provisioning descriptor exists for the requested rollback revision');
    }
    return clone(target);
  }
  private async assertRevisionApproved(projectId: string, revisionId: string): Promise<void> {
    if (!await this.options.isRevisionApproved(projectId, revisionId)) {
      throw new CynderDeploymentError(409, 'FOLDY_APPROVAL_REQUIRED', 'an approved review for the exact revision is required before deployment');
    }
  }
  private async assertCurrentGrant(projectId: string, descriptor: FoldyDeploymentMcpGrantDescriptor): Promise<void> {
    if (!await this.options.isCurrentMcpGrant(projectId, descriptor)) {
      throw new CynderDeploymentError(409, 'FOLDY_CYNDER_MCP_GRANT_STALE', 'persisted MCP grant is revoked, rotated, or no longer matches the project and scopes');
    }
  }
  private validateBase(input: DeploymentBaseInput): void {
    validId(input.projectId, 'projectId');
    validId(input.revisionId, 'revisionId');
    validId(input.environment, 'environment', ENVIRONMENT);
    validId(input.idempotencyKey, 'idempotencyKey', IDEMPOTENCY);
    if (input.expectedActiveProviderRevisionId !== null) validId(input.expectedActiveProviderRevisionId, 'expectedActiveProviderRevisionId');
  }
  private validateProvisioning(input: DeploymentInput): void {
    if (!input.accessPolicy || (input.accessPolicy.mode !== 'public' && input.accessPolicy.mode !== 'password_required')) {
      throw new CynderDeploymentError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'accessPolicy is required');
    }
    if (input.accessPolicy.mode === 'password_required' && !/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(input.accessPolicy.passwordScryptVerifier)) {
      throw new CynderDeploymentError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'password scrypt verifier is invalid');
    }
    if (!input.mcpGrant) throw new CynderDeploymentError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'MCP grant descriptor is required');
    validId(input.mcpGrant.grantId, 'mcpGrant.grantId');
    if (!DIGEST.test(input.mcpGrant.tokenSha256) || !Array.isArray(input.mcpGrant.scopes) || input.mcpGrant.scopes.length === 0) {
      throw new CynderDeploymentError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'MCP grant descriptor is invalid');
    }
    if (!input.mcpGrant.scopes.includes('read') || !input.mcpGrant.scopes.includes('deployer')) {
      throw new CynderDeploymentError(400, 'FOLDY_CYNDER_MCP_SCOPES_REQUIRED', 'deployed MCP descriptor must include read and deployer scopes');
    }
  }
}

export interface HttpCynderAdapterOptions {
  endpoint: string; secretEnv: string; fetch?: typeof globalThis.fetch;
  /** Timeout applied to every Cynder control-plane request. */
  timeoutMs?: number;
  /** Exact deployment hostnames accepted as provider binding identities. This is not a DNS-level SSRF guarantee. */
  deploymentHosts?: string[];
  /** Exact non-default ports accepted in provider bindings. */
  deploymentPorts?: number[];
  /** Exact allowlisted provider binding identities which may use HTTP. */
  allowHttpDeploymentHosts?: string[];
}
export class HttpCynderDeploymentAdapter implements CynderDeploymentAdapter {
  private readonly fetcher: typeof globalThis.fetch; private readonly endpoint: string; private readonly timeoutMs: number;
  private readonly deploymentHosts: Set<string>; private readonly deploymentPorts: Set<number>; private readonly allowHttpDeploymentHosts: Set<string>;
  constructor(private readonly options: HttpCynderAdapterOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); } catch { throw new Error('Cynder endpoint must be a valid HTTPS URL'); }
    const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw new Error('Cynder endpoint must use HTTPS except for explicit loopback HTTP endpoints');
    this.endpoint = endpoint.toString().replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Cynder timeoutMs must be a positive integer');
    const normalizeHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    this.deploymentHosts = new Set((options.deploymentHosts ?? [endpoint.hostname]).map(normalizeHost));
    this.deploymentPorts = new Set(options.deploymentPorts ?? []);
    this.allowHttpDeploymentHosts = new Set((options.allowHttpDeploymentHosts ?? []).map(normalizeHost));
    if (this.deploymentHosts.size === 0 || [...this.deploymentHosts].some((host) => !host)) throw new Error('Cynder deploymentHosts must contain hostnames');
    if ([...this.deploymentPorts].some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error('Cynder deploymentPorts must contain valid ports');
    if ([...this.allowHttpDeploymentHosts].some((host) => !this.deploymentHosts.has(host))) throw new Error('Cynder HTTP deployment hosts must also be deploymentHosts');
    if (!options.secretEnv || !/^[A-Z][A-Z0-9_]*$/.test(options.secretEnv)) throw new Error('Cynder secretEnv must name an environment variable');
  }
  private headers(): Record<string, string> { const token = process.env[this.options.secretEnv]; if (!token) throw new CynderDeploymentError(503, 'FOLDY_CYNDER_NOT_CONFIGURED', `Cynder credential reference ${this.options.secretEnv} is unavailable`); return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }
  private validateDeploymentUrl(value: string, label: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_URL_REJECTED', `Cynder returned an invalid ${label}`); }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const allowedProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && this.allowHttpDeploymentHosts.has(host));
    const nonDefaultPort = url.port === '' ? null : Number(url.port);
    if (url.username || url.password || url.hash || url.search || (nonDefaultPort !== null && !this.deploymentPorts.has(nonDefaultPort))
      || !allowedProtocol || !this.deploymentHosts.has(host) || isForbiddenDeploymentHostname(host)) {
      throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_URL_REJECTED', `Cynder ${label} violates the configured provider binding identity policy`);
    }
    return url;
  }
  private validateDeploymentBinding(binding: CynderDeploymentBinding): CynderDeploymentBinding {
    assertProviderBindingIdentity(binding);
    const url = this.validateDeploymentUrl(binding.url, 'deployment URL');
    const mcpUrl = this.validateDeploymentUrl(binding.mcpUrl, 'MCP URL');
    if (binding.accessMode !== 'public' && binding.accessMode !== 'password_required') {
      throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_MISMATCH', 'Cynder returned an invalid access mode');
    }
    return { ...binding, url: url.href, mcpUrl: mcpUrl.href };
  }
  private async json(method: string, route: string, body?: unknown): Promise<any> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    let payload: any;
    try {
      response = await this.fetcher(this.endpoint + route, {
        method,
        headers: this.headers(),
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      try {
        payload = await response.json();
      } catch (error) {
        if (signal.aborted) throw error;
        payload = {};
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
        throw new CynderDeploymentError(504, 'FOLDY_CYNDER_PROVIDER_TIMEOUT', 'Cynder provider request timed out');
      }
      throw new CynderDeploymentError(502, 'FOLDY_CYNDER_PROVIDER_FAILED', 'Cynder provider request failed');
    }
    if (!response.ok) throw new CynderDeploymentError(response.status, typeof payload?.error?.code === 'string' ? payload.error.code : 'FOLDY_CYNDER_PROVIDER_FAILED', 'Cynder provider request failed');
    return payload;
  }
  preflight(input: Parameters<CynderDeploymentAdapter['preflight']>[0]) { return this.json('POST', '/v1/foldy/deployments/preflight', input); }
  async deployImmutable(input: Parameters<CynderDeploymentAdapter['deployImmutable']>[0]) { const binding = await this.json('POST', '/v1/foldy/deployments/immutable', input) as CynderDeploymentBinding; return this.validateDeploymentBinding(binding); }
  async activate(input: Parameters<CynderDeploymentAdapter['activate']>[0]) { await this.json('POST', '/v1/foldy/deployments/activate', input); }
  async inspect(input: Parameters<CynderDeploymentAdapter['inspect']>[0]) { const query = new URLSearchParams({ project_id: input.projectId, environment: input.environment }); const binding = await this.json('GET', `/v1/foldy/deployments/active?${query}`) as CynderDeploymentBinding | null; return binding ? this.validateDeploymentBinding(binding) : null; }
  async rollback(input: Parameters<CynderDeploymentAdapter['rollback']>[0]) { await this.json('POST', '/v1/foldy/deployments/rollback', input); }
  async verifyHealth(input: Parameters<CynderDeploymentAdapter['verifyHealth']>[0]): Promise<CynderHealthResult> {
    const binding = this.validateDeploymentBinding(input.binding);
    const payload = await this.json('POST', '/v1/foldy/deployments/health', { ...input, binding }) as { checks?: unknown };
    const checks = payload?.checks;
    const decoded = Array.isArray(checks) && checks.every((check) => {
      if (!check || typeof check !== 'object') return false;
      const candidate = check as { name?: unknown; ok?: unknown; status?: unknown };
      return typeof candidate.name === 'string' && typeof candidate.ok === 'boolean'
        && (candidate.status === undefined || (typeof candidate.status === 'number' && Number.isInteger(candidate.status)));
    });
    const expectedNames = [`entry:${input.entryFile}`, ...input.declaredRoutes.map((route) => `route:${route}`), 'mcp:initialize', 'mcp:list', 'mcp:read'];
    const healthy = decoded && (checks as CynderHealthResult['checks']).every((check) => check.ok)
      && expectedNames.every((name) => (checks as CynderHealthResult['checks']).filter((check) => check.name === name && check.ok).length === 1);
    if (!healthy) {
      throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'deployed revision failed authenticated HTTP or MCP semantic health verification', decoded ? { checks } : undefined);
    }
    return { checks: checks as CynderHealthResult['checks'] };
  }
  async revokeMcpGrant(input: McpGrantRevocationInput): Promise<void> {
    validId(input.grantId, 'grantId');
    validId(input.projectId, 'projectId');
    if (!DIGEST.test(input.tokenSha256)) throw new CynderDeploymentError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'invalid tokenSha256');
    try {
      await this.json('POST', '/v1/foldy/mcp/grants/revoke', input);
    } catch (error) {
      if (error instanceof CynderDeploymentError && error.status === 504) throw error;
      throw new CynderDeploymentError(502, 'FOLDY_CYNDER_PROVIDER_FAILED', 'Cynder provider request failed');
    }
  }
}
