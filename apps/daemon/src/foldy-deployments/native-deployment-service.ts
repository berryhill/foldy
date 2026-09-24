import type { FoldyReleaseIdentity, NativeDeploymentRequest, NativeDeploymentApproval, NativeDeploymentResponse } from '@open-design/contracts';
export type { FoldyReleaseIdentity, NativeDeploymentRequest, NativeDeploymentApproval, NativeDeploymentResponse } from '@open-design/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { NativeCynderConsumer, type NativeCynderBudget, type NativeCynderQuote, type NativeCynderReview, type NativeCynderDeployment } from './native-cynder.js';

/** Produced by an authenticated session resolver, never parsed from request JSON. */
export interface DeploymentOwner { principalId: string; sessionId: string }
/** Trusted, verified configuration binding. Resolve references against authoritative
 * custody at each admission. A client-supplied boolean is not an admission. */
export interface HostingAdmission {
  admissionRef: string; contractDigest: string; release: FoldyReleaseIdentity;
  ownerPrincipalId: string; origin: string; validUntil: string;
  durableStorage: { volumeIdentity: string; mountPath: string; retentionContractRef: string };
  bootstrap: { mode: 'sealed-one-use-owner'; protectedCustodyRef: string; ownerPrincipalId: string };
  singleWriter: { mode: 'exclusive-fenced'; fenceContractRef: string };
  transport: { mode: 'https-streamable-http'; routeContractRef: string; authenticationContractRef: string };
  /** Exact DEPLOY payload validated by the hosting-contract adapter; no invented fields. */
  nativeRequest: Record<string, unknown>;
}
interface RecordState extends NativeDeploymentResponse {
  ownerPrincipalId: string; approvalSessionId?: string; inputDigest: string;
  request: NativeDeploymentRequest; admissionDigest: string; nativeRequest: Record<string, unknown>;
}
export interface NativeDeploymentDependencies<Context> {
  consumer: NativeCynderConsumer; dataRoot: string; origin: string;
  requireOwner(context: Context, projectId: string): Promise<DeploymentOwner>;
  /** Must verify sealed release dependency closure and provider capability evidence.
   * No permissive default exists. Never wire directly to request body data. */
  resolveAdmission?(ref: string, owner: DeploymentOwner, release: FoldyReleaseIdentity): Promise<HostingAdmission>;
}
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
};
const hash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
const fail = (code: string): never => { throw new Error(code); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) fail('FOLDY_INVALID_REQUEST');
}
export function parseNativeDeploymentRequest(value: unknown): NativeDeploymentRequest {
  exact(value, ['schemaVersion', 'release', 'idempotencyKey', 'hostingAdmissionRef', 'budget']);
  exact(value.release, ['instanceId', 'projectId', 'workbookId', 'revisionId', 'releaseBundleDigest', 'imageDigest']);
  exact(value.budget, ['budgetId', 'perActionCap', 'totalCap']);
  const r = value.release; const b = value.budget;
  if (value.schemaVersion !== 'foldy-native-deployment.v1' || !id(value.idempotencyKey) || !id(value.hostingAdmissionRef)
    || !['instanceId', 'projectId', 'workbookId', 'revisionId'].every(k => id(r[k]))
    || typeof r.releaseBundleDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.releaseBundleDigest)
    || typeof r.imageDigest !== 'string' || !/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(r.imageDigest)
    || !id(b.budgetId) || !Number.isSafeInteger(b.perActionCap) || !Number.isSafeInteger(b.totalCap)
    || (b.perActionCap as number) <= 0 || (b.totalCap as number) < (b.perActionCap as number)) fail('FOLDY_INVALID_REQUEST');
  return structuredClone(value) as unknown as NativeDeploymentRequest;
}
export class NativeDeploymentService<Context> {
  private readonly root: string;
  constructor(private readonly deps: NativeDeploymentDependencies<Context>) {
    if (!path.isAbsolute(deps.dataRoot)) fail('FOLDY_INVALID_CONFIG');
    this.root = path.join(deps.dataRoot, 'foldy-native-deployments');
  }
  private async owner(ctx: Context, project: string): Promise<DeploymentOwner> {
    const owner = await this.deps.requireOwner(ctx, project);
    if (!owner || !id(owner.principalId) || !id(owner.sessionId)) fail('FOLDY_OWNER_REQUIRED');
    return owner;
  }
  private async admission(request: NativeDeploymentRequest, owner: DeploymentOwner): Promise<HostingAdmission> {
    if (!this.deps.resolveAdmission) fail('FOLDY_HOSTING_NOT_CONFIGURED');
    const a = await this.deps.resolveAdmission!(request.hostingAdmissionRef, owner, request.release);
    if (!a || a.admissionRef !== request.hostingAdmissionRef || a.ownerPrincipalId !== owner.principalId
      || a.origin !== this.deps.origin || !/^[a-f0-9]{64}$/.test(a.contractDigest)
      || !(Date.parse(a.validUntil) > Date.now()) || canonical(a.release) !== canonical(request.release)
      || !id(a.durableStorage?.volumeIdentity) || !path.posix.isAbsolute(a.durableStorage?.mountPath ?? '')
      || !id(a.durableStorage?.retentionContractRef) || a.bootstrap?.mode !== 'sealed-one-use-owner'
      || !id(a.bootstrap.protectedCustodyRef) || a.bootstrap.ownerPrincipalId !== owner.principalId
      || a.singleWriter?.mode !== 'exclusive-fenced' || !id(a.singleWriter.fenceContractRef)
      || a.transport?.mode !== 'https-streamable-http' || !id(a.transport.routeContractRef)
      || !id(a.transport.authenticationContractRef) || a.nativeRequest?.type !== 'DEPLOY'
      || a.nativeRequest.image_digest !== request.release.imageDigest) fail('FOLDY_HOSTING_NOT_ADMITTED');
    return structuredClone(a);
  }
  private file(operationId: string): string {
    if (!/^[a-f0-9]{64}$/.test(operationId)) fail('FOLDY_INVALID_REQUEST');
    return path.join(this.root, operationId + '.json');
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    // Reject writable or symlink ancestry. Root-owned sticky temporary ancestry is allowed for tests.
    let p = path.resolve(this.deps.dataRoot);
    for (;;) {
      const s = await lstat(p);
      if (!s.isDirectory() || ![0, process.getuid?.()].includes(s.uid)
        || ((s.mode & 0o022) && !(s.uid === 0 && (s.mode & 0o1000)))) fail('FOLDY_UNSAFE_CUSTODY');
      if (path.dirname(p) === p) break; p = path.dirname(p);
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const s = await lstat(this.root);
    if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077)) fail('FOLDY_UNSAFE_CUSTODY');
    const lock = path.join(this.root, '.writer-lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch { fail('FOLDY_BUSY_OR_RECOVERY_REQUIRED'); }
    try { return await fn(); } finally { await rm(lock, { recursive: true }); }
  }
  private async load(operationId: string): Promise<RecordState> {
    const f = await open(this.file(operationId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await f.stat();
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 262144) fail('FOLDY_UNSAFE_CUSTODY');
      const r = JSON.parse(await f.readFile('utf8')) as RecordState;
      if (r.operationId !== operationId || hash(r.request) !== r.inputDigest) fail('FOLDY_CORRUPT_CUSTODY');
      return r;
    } finally { await f.close(); }
  }
  private async save(r: RecordState): Promise<void> {
    const target = this.file(r.operationId); const temporary = target + '.' + randomUUID();
    const f = await open(temporary, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(r)); await f.sync(); } finally { await f.close(); }
    await rename(temporary, target);
    const d = await open(this.root, 'r'); try { await d.sync(); } finally { await d.close(); }
  }
  private view(r: RecordState): NativeDeploymentResponse {
    return structuredClone({ schemaVersion: r.schemaVersion, operationId: r.operationId, release: r.release,
      state: r.state, foldyActivation: 'not_verified', ...(r.review ? { review: r.review } : {}),
      ...(r.originalDeployActionId ? { originalDeployActionId: r.originalDeployActionId } : {}),
      ...(r.deployment ? { deployment: r.deployment } : {}) });
  }
  private async denyOtherUncertain(operationId: string): Promise<void> {
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file) || file === operationId + '.json') continue;
      const r = await this.load(file.slice(0, -5));
      if (r.state === 'preparing' || r.state === 'execution_unknown') fail('CYNDER_RECONCILE_REQUIRED');
    }
  }
  async prepare(ctx: Context, value: unknown): Promise<NativeDeploymentResponse> {
    const request = parseNativeDeploymentRequest(value);
    const owner = await this.owner(ctx, request.release.projectId);
    const a = await this.admission(request, owner); // BEFORE prepare/sign/payment
    const operationId = hash([owner.principalId, request.release.projectId, request.idempotencyKey]);
    return this.locked(async () => {
      await this.denyOtherUncertain(operationId);
      let r: RecordState;
      try { r = await this.load(operationId); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        r = { schemaVersion: 'foldy-native-deployment-result.v1', operationId, release: request.release,
          state: 'preparing', foldyActivation: 'not_verified', ownerPrincipalId: owner.principalId,
          inputDigest: hash(request), request, admissionDigest: hash(a), nativeRequest: a.nativeRequest };
        await this.save(r);
      }
      if (r.inputDigest !== hash(request) || r.admissionDigest !== hash(a)) fail('FOLDY_REVIEW_CHANGED');
      if (r.state !== 'preparing') return this.view(r);
      const review = await this.deps.consumer.prepare({ operationId, request: r.nativeRequest,
        idempotencyKey: operationId, reviewedStateDigest: hash([request, a]) });
      if (!review.actionId) fail('FOLDY_DEPLOY_CUSTODY_MISMATCH');
      r.review = review; r.originalDeployActionId = review.actionId!; await this.save(r);
      r.review = await this.deps.consumer.challenge(operationId, request.budget);
      r.state = 'quoted'; await this.save(r); return this.view(r);
    });
  }
  private async owned(ctx: Context, operationId: string): Promise<{ r: RecordState; owner: DeploymentOwner }> {
    const r = await this.load(operationId); const owner = await this.owner(ctx, r.release.projectId);
    if (owner.principalId !== r.ownerPrincipalId) fail('FOLDY_OWNER_REQUIRED');
    return { r, owner };
  }
  private async checkedReview(r: RecordState, review: NativeCynderReview): Promise<NativeCynderReview> {
    if (!review || review.operationId !== r.operationId || !r.review
      || review.requestDigest !== r.review.requestDigest || review.reviewedStateDigest !== r.review.reviewedStateDigest
      || !r.originalDeployActionId || review.actionId !== r.originalDeployActionId
      || (review.observation && review.observation.actionId !== r.originalDeployActionId)) {
      r.state = 'execution_unknown'; delete r.deployment;
      await this.save(r);
      fail('FOLDY_DEPLOY_CUSTODY_MISMATCH');
    }
    return review;
  }
  async execute(ctx: Context, approval: NativeDeploymentApproval): Promise<NativeDeploymentResponse> {
    exact(approval, ['operationId', 'reviewedStateDigest', 'requestDigest', 'approvedQuote']);
    return this.locked(async () => {
      const { r, owner } = await this.owned(ctx, approval.operationId);
      await this.denyOtherUncertain(r.operationId);
      const a = await this.admission(r.request, owner);
      if (hash(a) !== r.admissionDigest || r.state !== 'quoted' || !r.review
        || approval.requestDigest !== r.review.requestDigest || approval.reviewedStateDigest !== r.review.reviewedStateDigest
        || canonical(approval.approvedQuote) !== canonical(r.review.quote)) fail('FOLDY_APPROVAL_MISMATCH');
      r.state = 'execution_unknown'; r.approvalSessionId = owner.sessionId; await this.save(r);
      r.review = await this.checkedReview(r, await this.deps.consumer.execute({ ...approval, allowSpend: true }));
      // Even a successful execute is followed by an independent same-action read.
      r.review = await this.checkedReview(r, await this.deps.consumer.reconcile(r.operationId));
      r.state = r.review.observation?.settledEvidence && ['SUCCEEDED', 'FAILED'].includes(r.review.observation.status) ? 'observed' : 'execution_unknown';
      await this.save(r); return this.view(r);
    });
  }
  async reconcile(ctx: Context, operationId: string, deploymentId?: string): Promise<NativeDeploymentResponse> {
    return this.locked(async () => {
      const { r } = await this.owned(ctx, operationId);
      if (!['execution_unknown', 'observed', 'deployment_observed'].includes(r.state)) fail('FOLDY_EXECUTION_REQUIRED');
      // A previous deployment read is not current evidence. Persist invalidation
      // before external reads so a failed read cannot revive stale readiness.
      delete r.deployment; r.state = 'execution_unknown'; await this.save(r);
      r.review = await this.checkedReview(r, await this.deps.consumer.reconcile(operationId));
      r.state = r.review.observation?.settledEvidence && ['SUCCEEDED', 'FAILED'].includes(r.review.observation.status) ? 'observed' : 'execution_unknown';
      if (deploymentId && r.review.observation?.status === 'SUCCEEDED' && r.review.observation.settledEvidence) {
        const deployment = await this.deps.consumer.getDeployment(operationId, deploymentId);
        if (deployment.deployActionId !== r.originalDeployActionId) fail('FOLDY_DEPLOY_CUSTODY_MISMATCH');
        if (deployment.activeVersionId) {
          const v = await this.deps.consumer.getVersion(operationId, deploymentId, deployment.activeVersionId);
          if (!v.active || v.version.imageDigest !== r.release.imageDigest) fail('FOLDY_IMAGE_READBACK_MISMATCH');
        }
        r.deployment = deployment; r.state = 'deployment_observed';
      }
      await this.save(r); return this.view(r);
    });
  }
  async inspect(ctx: Context, operationId: string): Promise<NativeDeploymentResponse> {
    return this.locked(async () => this.view((await this.owned(ctx, operationId)).r));
  }
}
