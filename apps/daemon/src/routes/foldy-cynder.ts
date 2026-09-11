import type { Express, Request, Response } from 'express';
import type { FoldyMcpGrantStore } from '../foldy-mcp/grants.js';
import type { CynderDeploymentReceipt } from '../foldy-deployments/cynder.js';

interface DeploymentInput { projectId: string; revisionId: string; environment: string; idempotencyKey: string; expectedActiveProviderRevisionId: string | null }
interface DeploymentService { deploy(input: DeploymentInput): Promise<CynderDeploymentReceipt>; rollback(input: DeploymentInput): Promise<CynderDeploymentReceipt> }
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
function authorize(service: FoldyCynderRoutesService, req: Request, projectId: string): void {
  if (service.isLocalAuthority(req)) return;
  const token = bearer(req); const grant = token ? service.grants.authenticate(token, projectId, 'deployer') : null;
  if (!grant) throw new RouteError(token ? 403 : 401, token ? 'FOLDY_CYNDER_SCOPE_DENIED' : 'FOLDY_CYNDER_UNAUTHORIZED', 'deployer grant or local administrative authority required');
}
function input(req: Request, projectId: string, revisionId: string): DeploymentInput {
  if (!record(req.body)) throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'request body must be an object');
  const allowed = new Set(['environment', 'idempotencyKey', 'expectedActiveProviderRevisionId']);
  if (Object.keys(req.body).some((key) => !allowed.has(key))) throw new RouteError(400, 'FOLDY_CYNDER_DERIVED_BINDING_REQUIRED', 'project, revision, and bundle are derived by Foldy and cannot be supplied');
  const { environment, idempotencyKey, expectedActiveProviderRevisionId } = req.body;
  if (typeof environment !== 'string' || typeof idempotencyKey !== 'string' || (expectedActiveProviderRevisionId !== null && typeof expectedActiveProviderRevisionId !== 'string')) throw new RouteError(400, 'FOLDY_CYNDER_INVALID_REQUEST', 'environment, idempotencyKey, and expectedActiveProviderRevisionId are required');
  return { projectId, revisionId, environment, idempotencyKey, expectedActiveProviderRevisionId };
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
    const receipt = await service.deployments[kind](input(req, projectId, revisionId));
    res.setHeader('cache-control', 'no-store'); res.status(kind === 'deploy' ? 201 : 200).json(receipt);
  });
  app.post('/api/projects/:projectId/revisions/:revisionId/cynder/deploy', operation('deploy'));
  app.post('/api/projects/:projectId/revisions/:revisionId/cynder/rollback', operation('rollback'));
}
