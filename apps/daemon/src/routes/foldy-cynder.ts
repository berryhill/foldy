import { createHash, scrypt } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  DeployFoldyRevisionRequest,
  FoldyCynderDeploymentResponse,
  FoldyCynderStatusResponse,
  FoldyDeploymentAccessPolicy,
  RollbackFoldyRevisionRequest,
} from '@open-design/contracts';
import type { Express, Request, Response } from 'express';
import type { FoldyMcpGrantStore } from '../foldy-mcp/grants.js';
import { createFoldyRemoteMcpInstallInfo } from '../foldy-mcp/install-info.js';
import type { CynderDeploymentReceipt, CynderDeploymentStatusSnapshot, CynderRecoveryInput, DeploymentInput, RollbackDeploymentInput } from '../foldy-deployments/cynder.js';

interface DeploymentService {
  deploy(input: DeploymentInput): Promise<CynderDeploymentReceipt>;
  rollback(input: RollbackDeploymentInput): Promise<CynderDeploymentReceipt>;
  getStatus(projectId: string, environment: string): Promise<CynderDeploymentStatusSnapshot>;
  recover(input: CynderRecoveryInput): Promise<CynderDeploymentReceipt>;
}
export interface FoldyCynderRoutesService {
  deployments: DeploymentService;
  grants: FoldyMcpGrantStore;
  isLocalAuthority(req: Request): boolean;
  isFormalProject(projectId: string): boolean;
}
export interface RegisterFoldyCynderRoutesDeps { foldyCynder: FoldyCynderRoutesService }
class RouteError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function bearer(req: Request): string | null { return /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? null; }
function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.toLowerCase().split('%', 1)[0] ?? '';
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(ipv4) === 4 && Number(ipv4.split('.')[0]) === 127;
}
function hasSecurePasswordTransport(req: Request): boolean {
  return req.secure || isLoopbackAddress(req.ip) || isLoopbackAddress(req.socket.remoteAddress);
}
function authorize(service: FoldyCynderRoutesService, req: Request, projectId: string): void {
  if (service.isLocalAuthority(req)) return;
  const token = bearer(req); const grant = token ? service.grants.authenticate(token, projectId, 'deployer') : null;
  if (!grant) throw new RouteError(token ? 403 : 401, token ? 'FOLDY_CYNDER_SCOPE_DENIED' : 'FOLDY_CYNDER_UNAUTHORIZED', 'deployer grant or local administrative authority required');
}
async function derivePasswordScryptVerifier(password: string, saltContext: string): Promise<string> {
  const salt = createHash('sha256').update(saltContext).digest('hex').slice(0, 32);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
  return `scrypt$16384$8$1$${salt}$${derived.toString('hex')}`;
}
async function input(service: FoldyCynderRoutesService, req: Request, projectId: string, revisionId: string): Promise<DeploymentInput> {
  if (!record(req.body)) throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'request body must be an object');
  const allowed = new Set(['environment', 'idempotencyKey', 'expectedActiveProviderRevisionId', 'accessMode', 'password', 'mcpGrantId']);
  if (Object.keys(req.body).some((key) => !allowed.has(key))) throw new RouteError(400, 'FOLDY_CYNDER_DERIVED_BINDING_REQUIRED', 'project, revision, bundle, access verifier, and MCP descriptor are derived by Foldy and cannot be supplied');
  const body = req.body as unknown as DeployFoldyRevisionRequest;
  const { environment, idempotencyKey, expectedActiveProviderRevisionId, mcpGrantId } = body;
  if (typeof environment !== 'string' || typeof idempotencyKey !== 'string' || (expectedActiveProviderRevisionId !== null && typeof expectedActiveProviderRevisionId !== 'string') || typeof mcpGrantId !== 'string') {
    throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'environment, idempotencyKey, expectedActiveProviderRevisionId, and mcpGrantId are required');
  }
  const accessMode = body.accessMode ?? 'public';
  let accessPolicy: FoldyDeploymentAccessPolicy;
  if (accessMode === 'password_required') {
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 1024) throw new RouteError(400, 'FOLDY_CYNDER_PASSWORD_REQUIRED', 'password_required access needs a password between 8 and 1024 characters');
    if (!hasSecurePasswordTransport(req)) throw new RouteError(400, 'FOLDY_CYNDER_INSECURE_PASSWORD_TRANSPORT', 'password deployment requests require HTTPS or a loopback connection');
    accessPolicy = {
      mode: 'password_required',
      passwordScryptVerifier: await derivePasswordScryptVerifier(body.password, `${projectId}\0${revisionId}\0${environment}\0${idempotencyKey}\0${mcpGrantId}`),
    };
  } else if (accessMode === 'public') {
    if (body.password !== undefined) throw new RouteError(400, 'FOLDY_CYNDER_PASSWORD_NOT_ALLOWED', 'password is only accepted for password_required access');
    accessPolicy = { mode: 'public' };
  } else {
    throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'accessMode must be public or password_required');
  }
  const mcpGrant = service.grants.deploymentDescriptor(mcpGrantId, projectId);
  if (!mcpGrant) throw new RouteError(400, 'FOLDY_CYNDER_MCP_GRANT_INVALID', 'MCP grant must exist, be active, and belong to the deployment project');
  return { projectId, revisionId, environment, idempotencyKey, expectedActiveProviderRevisionId, accessPolicy, mcpGrant };
}
function rollbackInput(req: Request, projectId: string, revisionId: string): RollbackDeploymentInput {
  if (!record(req.body)) throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'request body must be an object');
  const allowed = new Set(['environment', 'idempotencyKey', 'expectedActiveProviderRevisionId']);
  if (Object.keys(req.body).some((key) => !allowed.has(key))) throw new RouteError(400, 'FOLDY_CYNDER_DERIVED_BINDING_REQUIRED', 'rollback accepts only environment, idempotencyKey, and the active provider precondition');
  const body = req.body as unknown as RollbackFoldyRevisionRequest;
  const { environment, idempotencyKey, expectedActiveProviderRevisionId } = body;
  if (typeof environment !== 'string' || typeof idempotencyKey !== 'string' || (expectedActiveProviderRevisionId !== null && typeof expectedActiveProviderRevisionId !== 'string')) {
    throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'environment, idempotencyKey, and expectedActiveProviderRevisionId are required');
  }
  return { projectId, revisionId, environment, idempotencyKey, expectedActiveProviderRevisionId };
}
function deploymentResponse(receipt: CynderDeploymentReceipt): FoldyCynderDeploymentResponse {
  const accessPolicy = receipt.accessPolicy;
  const mcpGrant = receipt.mcpGrant;
  const publicReceipt: FoldyCynderDeploymentResponse = {
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    kind: receipt.kind,
    status: receipt.status,
    recoverable: receipt.recoverable === true,
    projectId: receipt.projectId,
    revisionId: receipt.revisionId,
    bundleSha256: receipt.bundleSha256,
    environment: receipt.environment,
    idempotencyKey: receipt.idempotencyKey,
    accessMode: accessPolicy?.mode ?? null,
    mcpGrantId: mcpGrant?.grantId ?? null,
    scopes: mcpGrant ? [...mcpGrant.scopes] : [],
    expectedActiveProviderRevisionId: receipt.expectedActiveProviderRevisionId,
    priorActive: receipt.priorActive,
    binding: receipt.binding,
    health: receipt.health,
    createdAt: receipt.createdAt,
    completedAt: receipt.completedAt,
    ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
    ...(receipt.rollbackError === undefined ? {} : { rollbackError: receipt.rollbackError }),
  };
  if (!receipt.binding || !mcpGrant) return publicReceipt;
  publicReceipt.remoteMcpInstallInfo = createFoldyRemoteMcpInstallInfo({
    mcpUrl: receipt.binding.mcpUrl,
    projectId: receipt.projectId,
    grantId: mcpGrant.grantId,
  });
  return publicReceipt;
}
function statusResponse(projectId: string, environment: string, status: CynderDeploymentStatusSnapshot): FoldyCynderStatusResponse {
  const completed = status.completed.map(deploymentResponse);
  const staged = status.staged.map(deploymentResponse);
  const response: FoldyCynderStatusResponse = { projectId, environment, binding: status.binding, completed, staged };
  const binding = status.binding;
  if (!binding) return response;
  const source = [...completed, ...staged].find((receipt) => {
    const receiptBinding = receipt.binding;
    return receiptBinding !== null && receiptBinding.providerDeploymentId === binding.providerDeploymentId && receiptBinding.providerRevisionId === binding.providerRevisionId;
  });
  if (source?.remoteMcpInstallInfo) response.remoteMcpInstallInfo = source.remoteMcpInstallInfo;
  return response;
}
function sendError(res: Response, error: unknown): void {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown; details?: unknown; rollbackFailed?: unknown };
  if (typeof candidate?.status === 'number' && typeof candidate.code === 'string') { res.status(candidate.status).json({ error: { code: candidate.code, message: String(candidate.message), ...(candidate.details ? { details: candidate.details } : {}), ...(candidate.rollbackFailed ? { rollbackFailed: true } : {}) } }); return; }
  res.status(500).json({ error: { code: 'FOLDY_CYNDER_INTERNAL_ERROR', message: 'Foldy Cynder operation failed' } });
}
function wrap(handler: (req: Request, res: Response) => Promise<void>) { return async (req: Request, res: Response) => { try { await handler(req, res); } catch (error) { sendError(res, error); } }; }
export function registerFoldyCynderRoutes(app: Express, ctx: RegisterFoldyCynderRoutesDeps): void {
  const service = ctx.foldyCynder;
  const operation = (kind: 'deploy' | 'rollback') => wrap(async (req, res) => {
    const projectId = String(req.params.projectId); const revisionId = String(req.params.revisionId);
    if (!service.isFormalProject(projectId)) throw new RouteError(404, 'FOLDY_PROJECT_NOT_FOUND', 'formal Foldy project was not found');
    authorize(service, req, projectId);
    const receipt = kind === 'deploy'
      ? await service.deployments.deploy(await input(service, req, projectId, revisionId))
      : await service.deployments.rollback(rollbackInput(req, projectId, revisionId));
    res.setHeader('cache-control', 'no-store'); res.status(kind === 'deploy' ? 201 : 200).json(deploymentResponse(receipt));
  });
  app.post('/api/projects/:projectId/revisions/:revisionId/cynder/deploy', operation('deploy'));
  app.post('/api/projects/:projectId/revisions/:revisionId/cynder/rollback', operation('rollback'));
  app.get('/api/projects/:projectId/cynder/status', wrap(async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!service.isFormalProject(projectId)) throw new RouteError(404, 'FOLDY_PROJECT_NOT_FOUND', 'formal Foldy project was not found');
    authorize(service, req, projectId);
    if (typeof req.query.environment !== 'string' || !req.query.environment) throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'environment is required');
    const environment = req.query.environment;
    const status = await service.deployments.getStatus(projectId, environment);
    res.setHeader('cache-control', 'no-store'); res.json(statusResponse(projectId, environment, status));
  }));
  app.post('/api/projects/:projectId/cynder/recover', wrap(async (req, res) => {
    const projectId = String(req.params.projectId);
    if (!service.isFormalProject(projectId)) throw new RouteError(404, 'FOLDY_PROJECT_NOT_FOUND', 'formal Foldy project was not found');
    authorize(service, req, projectId);
    if (!record(req.body)) throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'request body must be an object');
    const allowed = new Set(['environment', 'receiptId']);
    if (Object.keys(req.body).some((key) => !allowed.has(key))) throw new RouteError(400, 'FOLDY_CYNDER_RECOVERY_DERIVED_REQUEST_REQUIRED', 'recovery accepts only persisted attempt identity and cannot replace deployment fields');
    const environment = req.body.environment; const receiptId = req.body.receiptId;
    if (typeof environment !== 'string' || !environment || (receiptId !== undefined && (typeof receiptId !== 'string' || !receiptId))) throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'environment and optional receiptId must be non-empty strings');
    const recovered = await service.deployments.recover({ projectId, environment, ...(receiptId === undefined ? {} : { receiptId }) });
    res.setHeader('cache-control', 'no-store'); res.json(deploymentResponse(recovered));
  }));
}
