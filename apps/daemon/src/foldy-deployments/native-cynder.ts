import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Native CLI operations, not the legacy /v1/foldy adapter protocol. */
export type NativeCynderAction = 'DEPLOY' | 'DEPLOY_VERSION' | 'ROLLBACK_VERSION' | 'ENROLL_WALLET' | 'INVOKE' | 'DELETE' | 'REGISTER_ARTIFACT' | 'RETAIN_ARTIFACT';
export interface NativeCynderConfig {
  /** Explicit installed scripts/cynder_agent.py, never an inferred skill location. */
  consumerPath: string;
  /** Operator-pinned installed consumer bytes; not inferred provider compatibility. */
  consumerSha256: string;
  /** Only operations separately admitted against the configured provider contract. */
  admittedActions: NativeCynderAction[];
  pythonPath: string;
  origin: string;
  /** Must be the resolved daemon RUNTIME_DATA_DIR. */
  dataRoot: string;
  /** Existing consumer custody can be retained across migration; never reset it. */
  consumerStateDir?: string;
  signerHelper: string;
  paymentHelper?: string;
  expectedPayee: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Protected custody references only. No inline keys or authorization material. */
  helperEnvironment?: Record<string, string>;
}
export interface NativeCynderBudget { budgetId: string; perActionCap: number; totalCap: number }
export interface NativeCynderQuote {
  quoteId: string; actionId: string; amountAtomic: number;
  network: string; asset: string; payee: string;
  budgetId: string; totalCapAtomic: number;
}
export interface NativeCynderReview {
  operationId: string; requestDigest: string; reviewedStateDigest: string;
  actionId?: string; actionDigest?: string; quote?: NativeCynderQuote;
  phase: 'preparing' | 'prepared' | 'quoted' | 'execution_unknown' | 'observed';
  observation?: NativeCynderObservation;
}
export interface NativeCynderObservation {
  actionId: string; status: string; paymentStatus: string;
  /** Payment/receipt evidence is not deployment health or activation proof. */
  settledEvidence: boolean;
}
export interface NativeCynderDeployment {
  deploymentId: string; deployActionId: string; status: string; deleted: boolean; deletePending: boolean;
  activeVersionId?: string; activeActivationId?: string;
}
export interface NativeCynderVersion {
  deploymentId: string; versionId: string; actionId: string; imageDigest: string; createdAt: string; tupleDigest?: string;
}
interface RecordState extends NativeCynderReview {
  /** Established only by an identity-validated owner deployment read; never replaced. */
  deploymentId?: string;
  origin: string; type: NativeCynderAction; request: Record<string, unknown>;
  idempotencyKey: string; budget?: NativeCynderBudget;
}
export class NativeCynderError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeCynderError'; this.code = code; }
}
function fail(code = 'CYNDER_INVALID_RESPONSE'): never { throw new NativeCynderError(code); }
const NETWORK = 'eip155:8453';
const ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH = /^[0-9a-f]{64}$/;
const ACTION = /^act_[0-9a-f]{32}$/;
const DEPLOYMENT = /^dep_[0-9a-f]{32}$/;
const VERSION = /^ver_[0-9a-f]{32}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMANDS: Record<NativeCynderAction, string> = {
  DEPLOY: 'prepare-deploy', DEPLOY_VERSION: 'prepare-deploy-version', ROLLBACK_VERSION: 'prepare-rollback-version',
  ENROLL_WALLET: 'prepare-enroll-wallet', INVOKE: 'prepare-invoke', DELETE: 'prepare-delete',
  REGISTER_ARTIFACT: 'prepare-register-artifact', RETAIN_ARTIFACT: 'prepare-retain-artifact',
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(key => JSON.stringify(key) + ':' + canonical(obj[key])).join(',') + '}';
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function checkDigest(value: string): void { if (!HASH.test(value)) fail('CYNDER_INVALID_INPUT'); }
function publicReview(record: RecordState): NativeCynderReview {
  return structuredClone({ operationId: record.operationId, requestDigest: record.requestDigest,
    reviewedStateDigest: record.reviewedStateDigest, phase: record.phase,
    ...(record.actionId !== undefined ? { actionId: record.actionId } : {}),
    ...(record.actionDigest !== undefined ? { actionDigest: record.actionDigest } : {}),
    ...(record.quote !== undefined ? { quote: record.quote } : {}),
    ...(record.observation !== undefined ? { observation: record.observation } : {}) });
}

/**
 * Explicitly configured packaged-consumer bridge. No wallet, HTTP, signing or
 * payment implementation is duplicated here. The CLI already exports exact quote
 * identity and amount, so a Python library shim is unnecessary for these 8 types.
 * Library-only lease APIs are intentionally not fabricated.
 *
 * Single daemon writer: filesystem lock prevents concurrent processes. A crash
 * leaves its lock fail-closed; remove it only after operator-confirmed quiescence.
 * An execution-attempt marker is durable before launching any paid subprocess.
 * Uncertainty permits action-get only, never another execute or replacement key.
 */
export class NativeCynderConsumer {
  private readonly config: NativeCynderConfig;
  private readonly root: string;
  private readonly stateDir: string;
  constructor(config: NativeCynderConfig) {
    let origin: URL;
    try { origin = new URL(config.origin); } catch { fail('CYNDER_INVALID_CONFIG'); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== '/' || origin.origin !== config.origin) fail('CYNDER_INVALID_CONFIG');
    for (const p of [config.consumerPath, config.pythonPath, config.dataRoot, config.signerHelper, config.paymentHelper, config.consumerStateDir]) {
      if (p !== undefined && (!path.isAbsolute(p) || p.includes('\0'))) fail('CYNDER_INVALID_CONFIG');
    }
    if (!ADDRESS.test(config.expectedPayee.toLowerCase())) fail('CYNDER_INVALID_CONFIG');
    if (!HASH.test(config.consumerSha256) || !Array.isArray(config.admittedActions)
      || config.admittedActions.some(action => !Object.hasOwn(COMMANDS, action))) fail('CYNDER_INVALID_CONFIG');
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000)) fail('CYNDER_INVALID_CONFIG');
    if (config.maxOutputBytes !== undefined && (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 128 || config.maxOutputBytes > 2_097_152)) fail('CYNDER_INVALID_CONFIG');
    this.config = structuredClone(config);
    this.root = path.join(config.dataRoot, 'foldy-native-cynder');
    this.stateDir = config.consumerStateDir ?? path.join(this.root, 'consumer');
  }
  /** Allow root-owned sticky /tmp ancestry, but never writable nonsticky
   * ancestors, untrusted owners, or symlink components. */
  private async secureDirectories(directory: string, privateLeaf = false, create = false): Promise<void> {
    const resolved = path.resolve(directory);
    const parts = resolved.split(path.sep).filter(Boolean);
    let current = path.parse(resolved).root;
    try {
      for (let i = -1; i < parts.length; i++) {
        if (i >= 0) current = path.join(current, parts[i]!);
        let st;
        try { st = await lstat(current); } catch (error) {
          if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await mkdir(current, { mode: 0o700 }); st = await lstat(current);
        }
        const leaf = i === parts.length - 1;
        const stickySystem = !leaf && st.uid === 0 && (st.mode & 0o1000) !== 0;
        if (!st.isDirectory() || ![0, process.getuid?.()].includes(st.uid)
          || ((st.mode & 0o022) !== 0 && !stickySystem)
          || (leaf && privateLeaf && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0))) fail('CYNDER_INVALID_CONFIG');
      }
    } catch { fail('CYNDER_INVALID_CONFIG'); }
  }
  private async secureFile(file: string, executable: boolean, protectedMode = false): Promise<void> {
    try {
      await this.secureDirectories(path.dirname(file));
      const stat = await lstat(file);
      if (!stat.isFile() || ![0, process.getuid?.()].includes(stat.uid) || (protectedMode && stat.uid !== process.getuid?.()) || (stat.mode & 0o022) || (protectedMode && (stat.mode & 0o077))) fail('CYNDER_INVALID_CONFIG');
      await access(file, executable ? constants.X_OK : constants.R_OK);
    } catch { fail('CYNDER_INVALID_CONFIG'); }
  }
  private async invoke(args: string[], paid = false): Promise<Record<string, unknown>> {
    await this.secureFile(this.config.consumerPath, false);
    if (createHash('sha256').update(await readFile(this.config.consumerPath)).digest('hex') !== this.config.consumerSha256) fail('CYNDER_CONSUMER_CONTRACT_CHANGED');
    await this.secureFile(this.config.pythonPath, true);
    await this.secureFile(this.config.signerHelper, true, true);
    if (paid) {
      if (!this.config.paymentHelper) fail('CYNDER_PAYMENT_NOT_CONFIGURED');
      await this.secureFile(this.config.paymentHelper, true, true);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    for (const [name, value] of Object.entries(this.config.helperEnvironment ?? {})) {
      if (!/^CYNDER_(SIGNER|PAYMENT)_[A-Z0-9_]*(FILE|PATH|REF)$/.test(name) || !path.isAbsolute(value)) fail('CYNDER_INVALID_CONFIG');
      env[name] = value;
    }
    const argv = [this.config.consumerPath, '--origin', this.config.origin, '--state-dir', this.stateDir,
      '--signer-helper', this.config.signerHelper];
    if (paid) argv.push('--payment-helper', this.config.paymentHelper!);
    argv.push(...args);
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.pythonPath, argv, { env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let size = 0; let ended = false;
      const stop = (code: string): void => {
        if (ended) return; ended = true; clearTimeout(timer);
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
        reject(new NativeCynderError(code));
      };
      const timer = setTimeout(() => stop('CYNDER_CONSUMER_TIMEOUT'), this.config.timeoutMs ?? 60_000);
      const collect = (chunk: Buffer, stdout: boolean): void => {
        size += chunk.length;
        if (size > (this.config.maxOutputBytes ?? 262_144)) return stop('CYNDER_CONSUMER_OUTPUT_LIMIT');
        if (stdout) output += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
      child.on('error', () => stop('CYNDER_CONSUMER_FAILED'));
      child.on('close', code => {
        if (ended) return; ended = true; clearTimeout(timer);
        if (code !== 0) return reject(new NativeCynderError('CYNDER_CONSUMER_FAILED'));
        try { resolve(object(JSON.parse(output))); } catch { reject(new NativeCynderError('CYNDER_INVALID_RESPONSE')); }
      });
    });
  }
  private file(id: string): string { checkDigest(id); return path.join(this.root, id + '.json'); }
  private async save(record: RecordState): Promise<void> {
    const target = this.file(record.operationId); const temporary = target + '.' + randomUUID();
    const fd = await open(temporary, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(record)); await fd.sync(); } finally { await fd.close(); }
    await rename(temporary, target);
    const dir = await open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  private async load(id: string): Promise<RecordState> {
    try {
      const file = this.file(id);
      await lstat(file);
      await this.secureFile(file, false, true);
      const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let record: RecordState;
      try { record = JSON.parse(await fd.readFile('utf8')) as RecordState; } finally { await fd.close(); }
      if (record.operationId !== id || record.origin !== this.config.origin
        || digest(record.request) !== record.requestDigest) fail('CYNDER_STATE_MISMATCH');
      return record;
    } catch (error) { if (error instanceof NativeCynderError) throw error; return fail('CYNDER_STATE_UNAVAILABLE'); }
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    // Validate custody and executable ancestry before any mutation; never chmod aliases.
    await this.secureDirectories(this.config.dataRoot);
    await this.secureFile(this.config.consumerPath, false);
    await this.secureFile(this.config.pythonPath, true);
    await this.secureFile(this.config.signerHelper, true, true);
    if (this.config.paymentHelper) await this.secureFile(this.config.paymentHelper, true, true);
    for (const dir of [this.root, this.stateDir]) {
      try { await lstat(dir); await this.secureDirectories(dir, true); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        let parent = path.dirname(dir);
        while (true) {
          try { await lstat(parent); break; } catch (missing) {
            if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') fail('CYNDER_INVALID_CONFIG');
            parent = path.dirname(parent);
          }
        }
        await this.secureDirectories(parent);
      }
    }
    await this.secureDirectories(this.root, true, true);
    await this.secureDirectories(this.stateDir, true, true);
    const lock = path.join(this.root, '.writer-lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch { return fail('CYNDER_BUSY_OR_RECOVERY_REQUIRED'); }
    try { return await fn(); } catch (error) {
      if (error instanceof NativeCynderError) throw error;
      return fail('CYNDER_LOCAL_STATE_ERROR');
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  async inspect(operationId: string): Promise<NativeCynderReview> { return this.locked(async () => publicReview(await this.load(operationId))); }

  /** Reads always authenticate with the durable original DEPLOY, not an activation/version action. */
  private async ownerDeployment(operationId: string, deploymentId: string): Promise<{ record: RecordState; deployment: NativeCynderDeployment }> {
    const record = await this.load(operationId);
    if (record.type !== 'DEPLOY' || record.request.type !== 'DEPLOY' || !record.actionId || !ACTION.test(record.actionId)
      || !record.actionDigest || !HASH.test(record.actionDigest)) fail('CYNDER_ORIGINAL_DEPLOY_REQUIRED');
    if (record.deploymentId !== undefined && record.deploymentId !== deploymentId) fail('CYNDER_DEPLOYMENT_BINDING_MISMATCH');
    const view = await this.invoke(['deployment-get', deploymentId, '--deploy-action-id', record.actionId]);
    const statuses = ['DEPLOYMENT_PENDING', 'DEPLOYING', 'READY', 'DELETE_PENDING', 'DELETING', 'DELETED', 'DEPLOYMENT_FAILED', 'DELETE_FAILED'];
    if (view.deployment_id !== deploymentId || view.deploy_action_id !== record.actionId
      || typeof view.status !== 'string' || !statuses.includes(view.status)
      || typeof view.deleted !== 'boolean' || typeof view.delete_pending !== 'boolean'
      || (view.active_version_id != null && (typeof view.active_version_id !== 'string' || !VERSION.test(view.active_version_id)))
      || (view.active_activation_id !== undefined && (typeof view.active_activation_id !== 'string' || !ACTION.test(view.active_activation_id)))) fail();
    const deployment: NativeCynderDeployment = { deploymentId, deployActionId: record.actionId, status: view.status,
      deleted: view.deleted, deletePending: view.delete_pending,
      ...(view.active_version_id != null ? { activeVersionId: view.active_version_id as string } : {}),
      ...(view.active_activation_id !== undefined ? { activeActivationId: view.active_activation_id as string } : {}) };
    if (record.deploymentId === undefined) { record.deploymentId = deploymentId; await this.save(record); }
    return { record, deployment };
  }
  async getDeployment(operationId: string, deploymentId: string): Promise<NativeCynderDeployment> {
    checkDigest(operationId); if (!DEPLOYMENT.test(deploymentId)) fail('CYNDER_INVALID_INPUT');
    return this.locked(async () => (await this.ownerDeployment(operationId, deploymentId)).deployment);
  }
  private version(value: unknown, deploymentId: string, versionId?: string): NativeCynderVersion {
    const v = object(value);
    if (v.deployment_id !== deploymentId || typeof v.version_id !== 'string' || !VERSION.test(v.version_id)
      || (versionId !== undefined && v.version_id !== versionId) || typeof v.action_id !== 'string' || !ACTION.test(v.action_id)
      || typeof v.image_digest !== 'string' || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(v.image_digest)
      || typeof v.created_at !== 'string' || !Number.isFinite(Date.parse(v.created_at))
      || (v.tuple_digest !== undefined && (typeof v.tuple_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(v.tuple_digest)))) fail();
    return { deploymentId, versionId: v.version_id, actionId: v.action_id, imageDigest: v.image_digest, createdAt: v.created_at,
      ...(v.tuple_digest !== undefined ? { tupleDigest: v.tuple_digest as string } : {}) };
  }
  async listVersions(operationId: string, deploymentId: string): Promise<{ deploymentId: string; activeVersionId?: string; versions: NativeCynderVersion[] }> {
    checkDigest(operationId); if (!DEPLOYMENT.test(deploymentId)) fail('CYNDER_INVALID_INPUT');
    return this.locked(async () => {
      const { record } = await this.ownerDeployment(operationId, deploymentId);
      const view = await this.invoke(['version-list', deploymentId, '--deploy-action-id', record.actionId!]);
      if (view.deployment_id !== deploymentId
        || (view.active_version_id != null && (typeof view.active_version_id !== 'string' || !VERSION.test(view.active_version_id)))
        || !Array.isArray(view.versions)) fail();
      const versions = view.versions.map(v => this.version(v, deploymentId));
      if (new Set(versions.map(v => v.versionId)).size !== versions.length) fail();
      return { deploymentId, ...(view.active_version_id != null ? { activeVersionId: view.active_version_id as string } : {}), versions };
    });
  }
  async getVersion(operationId: string, deploymentId: string, versionId: string): Promise<{ active: boolean; version: NativeCynderVersion }> {
    checkDigest(operationId); if (!DEPLOYMENT.test(deploymentId) || !VERSION.test(versionId)) fail('CYNDER_INVALID_INPUT');
    return this.locked(async () => {
      const { record } = await this.ownerDeployment(operationId, deploymentId);
      const view = await this.invoke(['version-get', deploymentId, versionId, '--deploy-action-id', record.actionId!]);
      if (typeof view.active !== 'boolean') fail();
      return { active: view.active, version: this.version(view.version, deploymentId, versionId) };
    });
  }

  /** Unpaid authenticated mutation. request includes type; CLI body must omit it. */
  async prepare(input: { operationId: string; request: Record<string, unknown>; idempotencyKey: string; reviewedStateDigest: string }): Promise<NativeCynderReview> {
    checkDigest(input.operationId); checkDigest(input.reviewedStateDigest);
    if (!ID.test(input.idempotencyKey)) fail('CYNDER_INVALID_INPUT');
    const request = JSON.parse(JSON.stringify(input.request)) as Record<string, unknown>;
    const type = request.type as NativeCynderAction;
    if (!this.config.admittedActions.includes(type)) fail('CYNDER_CAPABILITY_NOT_ADMITTED');
    if (!Object.hasOwn(COMMANDS, type) || Buffer.byteLength(JSON.stringify(request)) > 65_536) fail('CYNDER_INVALID_INPUT');
    return this.locked(async () => {
      let record: RecordState;
      try { record = await this.load(input.operationId); }
      catch (error) {
        // Only a truly absent file authorizes a new operation; corrupt records never do.
        try { await lstat(this.file(input.operationId)); } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          for (const name of await readdir(this.root)) {
            if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
            const prior = await this.load(name.slice(0, -5));
            if (prior.phase === 'preparing' || prior.phase === 'execution_unknown') fail('CYNDER_RECONCILE_REQUIRED');
            if (prior.idempotencyKey === input.idempotencyKey) fail('CYNDER_OPERATION_IDENTITY_CONFLICT');
          }
          record = { operationId: input.operationId, origin: this.config.origin, request, type,
            idempotencyKey: input.idempotencyKey, requestDigest: digest(request), reviewedStateDigest: input.reviewedStateDigest, phase: 'preparing' };
          await this.save(record);
        }
        if (!record!) throw error;
      }
      if (record.requestDigest !== digest(request) || record.idempotencyKey !== input.idempotencyKey
        || record.reviewedStateDigest !== input.reviewedStateDigest) fail('CYNDER_REVIEW_CHANGED');
      if (record.actionId) return publicReview(record);
      const { type: _type, ...body } = request;
      const result = await this.invoke([COMMANDS[type], '--request', JSON.stringify(body), '--idempotency-key', record.idempotencyKey]);
      if (result.origin !== record.origin || result.type !== type || result.idempotency_key !== record.idempotencyKey
        || typeof result.action_id !== 'string' || !ACTION.test(result.action_id)
        || typeof result.digest !== 'string' || !HASH.test(result.digest)) fail();
      record.actionId = result.action_id; record.actionDigest = result.digest; record.phase = 'prepared';
      await this.save(record); return publicReview(record);
    });
  }
  private async denyOtherUncertain(operationId: string): Promise<void> {
    for (const name of await readdir(this.root)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name) || name === operationId + '.json') continue;
      const prior = await this.load(name.slice(0, -5));
      if (prior.phase === 'preparing' || prior.phase === 'execution_unknown') fail('CYNDER_RECONCILE_REQUIRED');
    }
  }
  private budgetArgs(budget: NativeCynderBudget): string[] {
    if (!ID.test(budget.budgetId) || !Number.isSafeInteger(budget.perActionCap) || !Number.isSafeInteger(budget.totalCap)
      || budget.perActionCap <= 0 || budget.totalCap < budget.perActionCap) fail('CYNDER_INVALID_INPUT');
    return ['--expected-network', NETWORK, '--expected-asset', ASSET, '--expected-payee', this.config.expectedPayee.toLowerCase(),
      '--budget-id', budget.budgetId, '--per-action-cap', String(budget.perActionCap), '--total-cap', String(budget.totalCap)];
  }
  async challenge(operationId: string, budget: NativeCynderBudget): Promise<NativeCynderReview> {
    const args = this.budgetArgs(budget);
    return this.locked(async () => {
      await this.denyOtherUncertain(operationId);
      const record = await this.load(operationId);
      if (!record.actionId || !['prepared', 'quoted'].includes(record.phase)) fail('CYNDER_RECONCILE_REQUIRED');
      if (record.quote) {
        if (canonical(record.budget) !== canonical(budget)) fail('CYNDER_REVIEW_CHANGED');
        return publicReview(record);
      }
      const q = await this.invoke(['challenge', record.actionId, ...args]);
      if (q.origin !== record.origin || q.action_id !== record.actionId || typeof q.quote_id !== 'string' || !HASH.test(q.quote_id)
        || !Number.isSafeInteger(q.amount_atomic) || (q.amount_atomic as number) <= 0 || (q.amount_atomic as number) > budget.perActionCap
        || q.network !== NETWORK || q.asset !== ASSET || q.payee !== this.config.expectedPayee.toLowerCase()
        || q.budget_id !== budget.budgetId || q.total_cap_atomic !== budget.totalCap) fail();
      record.quote = { quoteId: q.quote_id, actionId: record.actionId, amountAtomic: q.amount_atomic as number,
        network: NETWORK, asset: ASSET, payee: q.payee as string, budgetId: budget.budgetId, totalCapAtomic: budget.totalCap };
      record.budget = structuredClone(budget); record.phase = 'quoted';
      await this.save(record); return publicReview(record);
    });
  }
  /** Caller must obtain explicit human approval of every field, not just a yes/no. */
  async execute(input: { operationId: string; requestDigest: string; reviewedStateDigest: string; approvedQuote: NativeCynderQuote; allowSpend: true }): Promise<NativeCynderReview> {
    return this.locked(async () => {
      await this.denyOtherUncertain(input.operationId);
      const record = await this.load(input.operationId);
      if (input.allowSpend !== true || input.requestDigest !== record.requestDigest || input.reviewedStateDigest !== record.reviewedStateDigest
        || !record.quote || canonical(input.approvedQuote) !== canonical(record.quote)) fail('CYNDER_APPROVAL_MISMATCH');
      if (record.phase !== 'quoted' || !record.actionId || !record.budget) fail('CYNDER_RECONCILE_REQUIRED');
      if (!this.config.admittedActions.includes(record.type)) fail('CYNDER_CAPABILITY_NOT_ADMITTED');
      // Persist before any helper/network call. Timeout/crash is never safe to retry.
      record.phase = 'execution_unknown'; await this.save(record);
      const view = await this.invoke(['execute', record.actionId, '--approved-quote-id', record.quote.quoteId,
        '--allow-spend', ...this.budgetArgs(record.budget)], true);
      record.observation = this.observation(view, record);
      if (record.observation.settledEvidence && record.observation.status !== 'UNKNOWN') record.phase = 'observed';
      await this.save(record); return publicReview(record);
    });
  }
  /** Reads the SAME action. Never creates a new quote, key, authorization or operation. */
  async reconcile(operationId: string): Promise<NativeCynderReview> {
    return this.locked(async () => {
      const record = await this.load(operationId);
      if (!record.actionId) fail('CYNDER_PREPARATION_REPLAY_REQUIRED');
      const view = await this.invoke(['action-get', record.actionId]);
      record.observation = this.observation(view, record);
      // An unpaid read after a lost response is NOT permission to execute again.
      if (record.phase === 'execution_unknown' && record.observation.settledEvidence && record.observation.status !== 'UNKNOWN') record.phase = 'observed';
      await this.save(record); return publicReview(record);
    });
  }
  private observation(view: Record<string, unknown>, record: RecordState): NativeCynderObservation {
    const action = object(view.action); const state = object(view.state);
    if (action.action_id !== record.actionId || action.digest !== record.actionDigest || action.type !== record.type
      || state.action_id !== record.actionId) fail();
    const statuses = ['PENDING', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'WAITING_EFFECTIVE_TIME'];
    const payments = ['UNPAID', 'SETTLING', 'SETTLEMENT_UNKNOWN', 'SETTLED'];
    if (typeof state.status !== 'string' || !statuses.includes(state.status)
      || typeof state.payment_status !== 'string' || !payments.includes(state.payment_status)) fail();
    let settledEvidence = false;
    if (state.payment_status === 'SETTLED') {
      if (!['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(state.status)) fail();
      if (record.type === 'ENROLL_WALLET') {
        const output = object(view.output);
        const profile = record.request.profile_name; const scopes = record.request.requested_scopes;
        if (typeof profile !== 'string' || !profile || !Array.isArray(scopes) || !scopes.length
          || output.status !== 'PENDING_REVIEW' || output.x402_active !== false
          || output.profile_name !== profile || canonical(output.requested_scopes) !== canonical(scopes)) fail();
      }
      const q = record.quote;
      if (!q || String(state.payment_amount) !== String(q.amountAtomic) || typeof state.payment_asset !== 'string' || state.payment_asset.toLowerCase() !== q.asset
        || typeof state.payment_pay_to !== 'string' || state.payment_pay_to.toLowerCase() !== q.payee
        || !Array.isArray(view.receipts) || view.receipts.length === 0
        || view.receipts.some(item => object(item).action_id !== record.actionId)) fail();
      settledEvidence = true;
    }
    return { actionId: record.actionId!, status: state.status, paymentStatus: state.payment_status, settledEvidence };
  }
}
