import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export type CynderDeploymentStatus = 'staged' | 'active' | 'rolled_back' | 'failed' | 'rollback_failed';
export interface FoldyRevisionManifest { revisionId: string; entryFile: string; bundleSha256: string; files: { path: string; sha256: string; size: number }[] }
export interface CynderBundleFile { path: string; sha256: string; bytesBase64: string }
export interface CynderDeploymentBinding { providerDeploymentId: string; providerRevisionId: string; projectId: string; revisionId: string; bundleSha256: string; environment: string; url: string }
export interface CynderPreflight { accepted: boolean; details?: Record<string, unknown> }
export interface CynderHealthResult { checks: { name: string; ok: boolean; status?: number }[] }
export interface CynderDeploymentAdapter {
  preflight(input: { projectId: string; revisionId: string; bundleSha256: string; environment: string; idempotencyKey: string; entryFile: string; declaredRoutes: string[] }): Promise<CynderPreflight>;
  deployImmutable(input: { projectId: string; revisionId: string; bundleSha256: string; environment: string; idempotencyKey: string; entryFile: string; files: CynderBundleFile[] }): Promise<CynderDeploymentBinding>;
  activate(input: { binding: CynderDeploymentBinding; expectedProviderRevisionId: string | null; idempotencyKey: string }): Promise<void>;
  inspect(input: { projectId: string; environment: string }): Promise<CynderDeploymentBinding | null>;
  verifyHealth(input: { binding: CynderDeploymentBinding; entryFile: string; declaredRoutes: string[] }): Promise<CynderHealthResult>;
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
  schemaVersion: 1; receiptId: string; kind: 'deploy' | 'rollback'; status: CynderDeploymentStatus;
  projectId: string; revisionId: string; bundleSha256: string; environment: string; idempotencyKey: string;
  expectedActiveProviderRevisionId: string | null; priorActive: CynderDeploymentBinding | null; binding: CynderDeploymentBinding | null;
  health: CynderHealthResult | null; createdAt: string; completedAt: string | null; errorCode?: string; rollbackError?: string;
}
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
  && left.url === right.url;
function validId(value: string, field: string, pattern = ID): void { if (typeof value !== 'string' || !pattern.test(value) || value === '.' || value === '..') throw new CynderDeploymentError(400, 'FOLDY_CYNDER_INVALID_REQUEST', `invalid ${field}`); }
function errorOf(error: unknown): CynderDeploymentError { return error instanceof CynderDeploymentError ? error : new CynderDeploymentError(502, 'FOLDY_CYNDER_PROVIDER_FAILED', 'Cynder provider operation failed'); }
function canonicalRequest(input: DeploymentInput, bundleSha256: string, kind: 'deploy' | 'rollback'): string { return JSON.stringify({ kind, projectId: input.projectId, revisionId: input.revisionId, bundleSha256, environment: input.environment, idempotencyKey: input.idempotencyKey, expectedActiveProviderRevisionId: input.expectedActiveProviderRevisionId }); }
async function atomicJson(directory: string, target: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, target); await chmod(target, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
interface DeploymentInput { projectId: string; revisionId: string; environment: string; idempotencyKey: string; expectedActiveProviderRevisionId: string | null }
interface ServiceOptions {
  dataRoot: string; adapter: CynderDeploymentAdapter; now?: () => Date;
  getRevision(projectId: string, revisionId: string): Promise<FoldyRevisionManifest>;
  readRevisionFile(projectId: string, revisionId: string, file: string): Promise<Buffer>;
}
export class FoldyCynderDeploymentService {
  private readonly root: string; private readonly now: () => Date; private locks = new Map<string, Promise<void>>();
  constructor(private readonly options: ServiceOptions) { if (!path.isAbsolute(options.dataRoot)) throw new Error('dataRoot must be absolute'); this.root = path.join(options.dataRoot, 'foldy-deployments'); this.now = options.now ?? (() => new Date()); }
  deploy(input: DeploymentInput): Promise<CynderDeploymentReceipt> { return this.run(input, 'deploy'); }
  rollback(input: DeploymentInput): Promise<CynderDeploymentReceipt> { return this.run(input, 'rollback'); }
  private async run(input: DeploymentInput, kind: 'deploy' | 'rollback'): Promise<CynderDeploymentReceipt> {
    this.validate(input);
    const idempotencyKey = hash(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`);
    const mutationKey = hash(`${input.projectId}\0${input.environment}`);
    const previous = this.locks.get(mutationKey) ?? Promise.resolve(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const queued = previous.then(() => gate); this.locks.set(mutationKey, queued); await previous;
    try { return await this.runLocked(input, kind, idempotencyKey); } finally { release(); if (this.locks.get(mutationKey) === queued) this.locks.delete(mutationKey); }
  }
  private async runLocked(input: DeploymentInput, kind: 'deploy' | 'rollback', key: string): Promise<CynderDeploymentReceipt> {
    const revision = await this.options.getRevision(input.projectId, input.revisionId);
    if (revision.revisionId !== input.revisionId || !DIGEST.test(revision.bundleSha256)) throw new CynderDeploymentError(500, 'FOLDY_CYNDER_REVISION_INVALID', 'immutable revision manifest is invalid');
    const canonical = canonicalRequest(input, revision.bundleSha256, kind); const receiptId = `cynder-${hash(canonical).slice(0, 32)}`;
    const finalDir = path.join(this.root, 'receipts'); const finalPath = path.join(finalDir, receiptId + '.json');
    try { const found = JSON.parse(await readFile(finalPath, 'utf8')) as CynderDeploymentReceipt; if (found.receiptId !== receiptId || canonicalRequest(found, found.bundleSha256, found.kind) !== canonical) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_IDEMPOTENCY_CONFLICT', 'idempotency key was reused for a different deployment'); return clone(found); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const stagedDir = path.join(this.root, 'staged'); const stagedPath = path.join(stagedDir, key + '.json');
    try {
      const staged = JSON.parse(await readFile(stagedPath, 'utf8')) as CynderDeploymentReceipt;
      if (canonicalRequest(staged, staged.bundleSha256, staged.kind) !== canonical) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_IDEMPOTENCY_CONFLICT', 'idempotency key was reused for a different deployment');
      if (staged.status === 'staged' && staged.binding
        && staged.binding.projectId === input.projectId && staged.binding.environment === input.environment
        && staged.binding.revisionId === input.revisionId && staged.binding.bundleSha256 === revision.bundleSha256) {
        const active = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
        if (sameBinding(active, staged.binding)) {
          const declaredRoutes = revision.files.map((file) => file.path).filter((file) => file !== revision.entryFile && /\.html?$/i.test(file));
          const health = staged.health ?? await this.options.adapter.verifyHealth({ binding: staged.binding, entryFile: revision.entryFile, declaredRoutes });
          const reconciled: CynderDeploymentReceipt = { ...staged, health, status: staged.kind === 'rollback' ? 'rolled_back' : 'active', completedAt: this.now().toISOString() };
          await atomicJson(finalDir, finalPath, reconciled); await rm(stagedPath, { force: true }); return clone(reconciled);
        }
      }
      throw new CynderDeploymentError(409, 'FOLDY_CYNDER_INCOMPLETE_ATTEMPT', 'prior deployment attempt did not complete safely', { receiptId: staged.receiptId, status: staged.status });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const prior = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
    if ((prior?.providerRevisionId ?? null) !== input.expectedActiveProviderRevisionId) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ACTIVE_CONFLICT', 'active Cynder revision changed', { expected: input.expectedActiveProviderRevisionId, actual: prior?.providerRevisionId ?? null });
    const rollbackBinding = kind === 'rollback' ? await this.findRollbackBinding(input, revision) : null;
    let receipt: CynderDeploymentReceipt = { schemaVersion: 1, receiptId, kind, status: 'staged', projectId: input.projectId, revisionId: input.revisionId, bundleSha256: revision.bundleSha256, environment: input.environment, idempotencyKey: input.idempotencyKey, expectedActiveProviderRevisionId: input.expectedActiveProviderRevisionId, priorActive: prior, binding: null, health: null, createdAt: this.now().toISOString(), completedAt: null };
    if (kind === 'rollback') receipt = { ...receipt, binding: rollbackBinding };
    await atomicJson(stagedDir, stagedPath, receipt);
    let deployed: CynderDeploymentBinding | null = null;
    try {
      if (kind === 'rollback') {
        const restore = rollbackBinding;
        if (!restore) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ROLLBACK_BINDING_UNKNOWN', 'no durable provider binding exists for the requested rollback revision');
        await this.options.adapter.rollback({
          projectId: input.projectId,
          environment: input.environment,
          failed: null,
          restore,
          expectedActiveProviderRevisionId: input.expectedActiveProviderRevisionId,
          idempotencyKey: receiptId,
        });
        deployed = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
        if (!sameBinding(deployed, restore)) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_ROLLBACK_VERIFY_FAILED', 'provider did not activate the exact durable rollback binding');
        const declaredRoutes = revision.files.map((file) => file.path).filter((file) => file !== revision.entryFile && /\.html?$/i.test(file));
        receipt.health = await this.options.adapter.verifyHealth({ binding: restore, entryFile: revision.entryFile, declaredRoutes });
      } else {
        const declaredRoutes = revision.files.map((file) => file.path).filter((file) => file !== revision.entryFile && /\.html?$/i.test(file));
        const preflight = await this.options.adapter.preflight({ ...input, idempotencyKey: receiptId, bundleSha256: revision.bundleSha256, entryFile: revision.entryFile, declaredRoutes });
        if (!preflight.accepted) throw new CynderDeploymentError(422, 'FOLDY_CYNDER_PREFLIGHT_REJECTED', 'Cynder rejected deployment preflight', preflight.details);
        const files: CynderBundleFile[] = [];
        for (const file of revision.files) { const bytes = await this.options.readRevisionFile(input.projectId, input.revisionId, file.path); if (bytes.byteLength !== file.size || hash(bytes) !== file.sha256) throw new CynderDeploymentError(500, 'FOLDY_CYNDER_BUNDLE_MISMATCH', 'revision blob does not match immutable manifest'); files.push({ path: file.path, sha256: file.sha256, bytesBase64: bytes.toString('base64') }); }
        deployed = await this.options.adapter.deployImmutable({ ...input, idempotencyKey: receiptId, bundleSha256: revision.bundleSha256, entryFile: revision.entryFile, files });
        if (deployed.projectId !== input.projectId || deployed.revisionId !== input.revisionId || deployed.bundleSha256 !== revision.bundleSha256 || deployed.environment !== input.environment) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_MISMATCH', 'provider response did not bind the exact revision bundle');
        receipt = { ...receipt, binding: deployed }; await atomicJson(stagedDir, stagedPath, receipt);
        await this.options.adapter.activate({ binding: deployed, expectedProviderRevisionId: input.expectedActiveProviderRevisionId, idempotencyKey: receiptId });
        const inspected = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
        if (!inspected || inspected.providerRevisionId !== deployed.providerRevisionId || inspected.revisionId !== deployed.revisionId || inspected.bundleSha256 !== deployed.bundleSha256) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ACTIVE_CONFLICT', 'Cynder activation did not retain the exact deployed revision');
        receipt.health = await this.options.adapter.verifyHealth({ binding: deployed, entryFile: revision.entryFile, declaredRoutes });
      }
      receipt = { ...receipt, binding: deployed, status: kind === 'rollback' ? 'rolled_back' : 'active', completedAt: this.now().toISOString() }; await atomicJson(finalDir, finalPath, receipt); await rm(stagedPath, { force: true }); return clone(receipt);
    } catch (failure) {
      const error = errorOf(failure); let rollbackError: string | undefined;
      if (kind === 'deploy' && deployed) {
        try {
          const active = await this.options.adapter.inspect({ projectId: input.projectId, environment: input.environment });
          if (!sameBinding(active, deployed)) throw new Error('failed deployment is no longer active');
          await this.options.adapter.rollback({
            projectId: input.projectId,
            environment: input.environment,
            failed: deployed,
            restore: prior,
            expectedActiveProviderRevisionId: deployed.providerRevisionId,
            idempotencyKey: `${receiptId}:compensate`,
          });
        } catch {
          rollbackError = 'provider rollback failed or active binding changed'; error.rollbackFailed = true;
        }
      }
      receipt = { ...receipt, binding: deployed, status: rollbackError ? 'rollback_failed' : 'failed', completedAt: this.now().toISOString(), errorCode: error.code, ...(rollbackError ? { rollbackError } : {}) }; await atomicJson(stagedDir, stagedPath, receipt); throw error;
    }
  }
  private async findRollbackBinding(input: DeploymentInput, revision: FoldyRevisionManifest): Promise<CynderDeploymentBinding> {
    const receiptsDir = path.join(this.root, 'receipts');
    let files: string[];
    try { files = await readdir(receiptsDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = []; else throw error; }
    const candidates: CynderDeploymentBinding[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let receipt: CynderDeploymentReceipt;
      try { receipt = JSON.parse(await readFile(path.join(receiptsDir, file), 'utf8')) as CynderDeploymentReceipt; }
      catch { continue; }
      const binding = receipt.binding;
      if (receipt.status === 'active' && binding
        && receipt.projectId === input.projectId && receipt.environment === input.environment
        && receipt.revisionId === input.revisionId && receipt.bundleSha256 === revision.bundleSha256
        && binding.projectId === input.projectId && binding.environment === input.environment
        && binding.revisionId === input.revisionId && binding.bundleSha256 === revision.bundleSha256) candidates.push(binding);
    }
    const binding = candidates[0];
    if (!binding || candidates.some((candidate) => !sameBinding(candidate, binding))) {
      throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ROLLBACK_BINDING_UNKNOWN', 'no unambiguous durable provider binding exists for the requested rollback revision');
    }
    return binding;
  }
  private validate(input: DeploymentInput): void { validId(input.projectId, 'projectId'); validId(input.revisionId, 'revisionId'); validId(input.environment, 'environment', ENVIRONMENT); validId(input.idempotencyKey, 'idempotencyKey', IDEMPOTENCY); if (input.expectedActiveProviderRevisionId !== null) validId(input.expectedActiveProviderRevisionId, 'expectedActiveProviderRevisionId'); }
}

export interface HttpCynderAdapterOptions {
  endpoint: string; secretEnv: string; fetch?: typeof globalThis.fetch;
  /** Exact deployment hostnames accepted from provider-controlled bindings. Defaults to the provider endpoint hostname. */
  deploymentHosts?: string[];
  /** Exact allowlisted public hosts which may use HTTP. */
  allowHttpDeploymentHosts?: string[];
}
export class HttpCynderDeploymentAdapter implements CynderDeploymentAdapter {
  private readonly fetcher: typeof globalThis.fetch; private readonly endpoint: string;
  private readonly deploymentHosts: Set<string>; private readonly allowHttpDeploymentHosts: Set<string>;
  constructor(private readonly options: HttpCynderAdapterOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); } catch { throw new Error('Cynder endpoint must be a valid HTTPS URL'); }
    const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw new Error('Cynder endpoint must use HTTPS except for explicit loopback HTTP endpoints');
    this.endpoint = endpoint.toString().replace(/\/$/, '');
    const normalizeHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    this.deploymentHosts = new Set((options.deploymentHosts ?? [endpoint.hostname]).map(normalizeHost));
    this.allowHttpDeploymentHosts = new Set((options.allowHttpDeploymentHosts ?? []).map(normalizeHost));
    if (this.deploymentHosts.size === 0 || [...this.deploymentHosts].some((host) => !host)) throw new Error('Cynder deploymentHosts must contain hostnames');
    if ([...this.allowHttpDeploymentHosts].some((host) => !this.deploymentHosts.has(host))) throw new Error('Cynder HTTP deployment hosts must also be deploymentHosts');
    if (!options.secretEnv || !/^[A-Z][A-Z0-9_]*$/.test(options.secretEnv)) throw new Error('Cynder secretEnv must name an environment variable');
  }
  private headers(): Record<string, string> { const token = process.env[this.options.secretEnv]; if (!token) throw new CynderDeploymentError(503, 'FOLDY_CYNDER_NOT_CONFIGURED', `Cynder credential reference ${this.options.secretEnv} is unavailable`); return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }
  private validateDeploymentBinding(binding: CynderDeploymentBinding): void {
    let url: URL;
    try { url = new URL(binding.url); } catch { throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_URL_REJECTED', 'Cynder returned an invalid deployment URL'); }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const allowedProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && this.allowHttpDeploymentHosts.has(host));
    if (url.username || url.password || !allowedProtocol || !this.deploymentHosts.has(host) || isForbiddenDeploymentHostname(host)) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_BINDING_URL_REJECTED', 'Cynder deployment URL violates the configured HTTPS host policy');
  }
  private async json(method: string, route: string, body?: unknown): Promise<any> { const response = await this.fetcher(this.endpoint + route, { method, headers: this.headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const payload: any = await response.json().catch(() => ({})); if (!response.ok) throw new CynderDeploymentError(response.status, typeof payload?.error?.code === 'string' ? payload.error.code : 'FOLDY_CYNDER_PROVIDER_FAILED', 'Cynder provider request failed'); return payload; }
  preflight(input: Parameters<CynderDeploymentAdapter['preflight']>[0]) { return this.json('POST', '/v1/foldy/deployments/preflight', input); }
  async deployImmutable(input: Parameters<CynderDeploymentAdapter['deployImmutable']>[0]) { const binding = await this.json('POST', '/v1/foldy/deployments/immutable', input) as CynderDeploymentBinding; this.validateDeploymentBinding(binding); return binding; }
  async activate(input: Parameters<CynderDeploymentAdapter['activate']>[0]) { await this.json('POST', '/v1/foldy/deployments/activate', input); }
  async inspect(input: Parameters<CynderDeploymentAdapter['inspect']>[0]) { const query = new URLSearchParams({ project_id: input.projectId, environment: input.environment }); const binding = await this.json('GET', `/v1/foldy/deployments/active?${query}`) as CynderDeploymentBinding | null; if (binding) this.validateDeploymentBinding(binding); return binding; }
  async rollback(input: Parameters<CynderDeploymentAdapter['rollback']>[0]) { await this.json('POST', '/v1/foldy/deployments/rollback', input); }
  async verifyHealth(input: Parameters<CynderDeploymentAdapter['verifyHealth']>[0]): Promise<CynderHealthResult> {
    this.validateDeploymentBinding(input.binding);
    const checks: CynderHealthResult['checks'] = []; const base = input.binding.url.replace(/\/$/, '');
    const httpRoutes: [string, string][] = [[`entry:${input.entryFile}`, '/'], ...input.declaredRoutes.map((route): [string, string] => [`route:${route}`, '/' + route])];
    for (const [name, route] of httpRoutes) {
      const response = await this.fetcher(base + route, { redirect: 'error' });
      const check = { name, ok: response.status >= 200 && response.status < 300, status: response.status };
      checks.push(check);
      if (!check.ok) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'deployed revision failed HTTP or MCP health verification', { checks });
    }
    let initialized = false;
    for (const [name, method, params] of [['mcp:initialize', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'foldy-health', version: '1' } }], ['mcp:list', 'resources/list', {}], ['mcp:read', 'resources/read', { uri: 'foldy://project/publication' }]] as const) { const response = await this.fetcher(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: name, method, params }), redirect: 'error' }); const payload = await response.json().catch(() => null) as any; const ok = response.ok && payload?.jsonrpc === '2.0' && !payload?.error; checks.push({ name, ok, status: response.status }); if (method === 'initialize') initialized = ok; if (!initialized) break; }
    if (checks.some((check) => !check.ok) || !checks.some((check) => check.name === 'mcp:read')) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'deployed revision failed HTTP or MCP health verification', { checks });
    return { checks };
  }
}
