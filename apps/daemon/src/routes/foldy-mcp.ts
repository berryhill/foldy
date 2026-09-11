import type { Express, Request, Response } from 'express';
import type { FoldyMcpGrant, FoldyMcpGrantStore, FoldyMcpScope } from '../foldy-mcp/grants.js';
import { createFoldyMcpInstallInfo } from '../foldy-mcp/install-info.js';
import { FoldyMcpArgumentsError, validateFoldyMcpToolArguments } from '../foldy-mcp/schemas.js';

interface FoldyProject { id: string; metadata?: unknown }
interface PublicationOperations {
  getState(projectId: string): Promise<unknown>;
  getRevision(projectId: string, revisionId: string): Promise<unknown>;
  saveRevision(input: { projectId: string; projectRoot: string; entryFile: string; publicationFiles?: readonly string[]; expectedLatestRevisionId: string | null; actorId: string }): Promise<unknown>;
  requestReview(input: { projectId: string; revisionId: string; expectedLatestRevisionId: string; actorId: string }): Promise<unknown>;
  addReviewComment(input: { projectId: string; revisionId: string; reviewId: string; body: string; expectedReviewVersion: number; actorId: string }): Promise<unknown>;
  decideReview(input: { projectId: string; revisionId: string; reviewId: string; decision: 'approved' | 'changes_requested'; expectedReviewVersion: number; actorId: string }): Promise<unknown>;
  publish(input: { projectId: string; revisionId: string; expectedPublishedGeneration: number; actorId: string }): Promise<unknown>;
  rollback(input: { projectId: string; targetRevisionId: string; expectedPublishedGeneration: number; actorId: string }): Promise<unknown>;
}

export interface FoldyMcpRoutesService {
  grants: FoldyMcpGrantStore;
  command: string;
  getDaemonUrl(): string;
  isLocalAuthority(req: Request): boolean;
  resolveProject(projectId: string): FoldyProject | null;
  resolveProjectRoot(project: FoldyProject): string;
  publicationStore: PublicationOperations;
  deploy(projectId: string, input: Record<string, unknown>): Promise<unknown>;
}
export interface RegisterFoldyMcpRoutesDeps { foldyMcp: FoldyMcpRoutesService }

class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function body(req: Request): Record<string, unknown> { if (!isRecord(req.body)) throw new HttpError(400, 'FOLDY_MCP_INVALID_REQUEST', 'request body must be an object'); return req.body; }
function text(input: Record<string, unknown>, name: string): string { if (typeof input[name] !== 'string' || input[name].length === 0) throw new HttpError(400, 'FOLDY_MCP_INVALID_REQUEST', `${name} is required`); return input[name]; }
function integer(input: Record<string, unknown>, name: string): number { if (!Number.isSafeInteger(input[name]) || (input[name] as number) < 0) throw new HttpError(400, 'FOLDY_MCP_INVALID_REQUEST', `${name} must be a non-negative integer`); return input[name] as number; }
function bearer(req: Request): string | null { const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? ''); return match?.[1] ?? null; }
function noStore(res: Response): void { res.setHeader('cache-control', 'no-store'); res.setHeader('pragma', 'no-cache'); }
function formalProject(service: FoldyMcpRoutesService, projectId: string): {
  project: FoldyProject;
  entryFile: string;
  publicationFiles: string[];
} {
  const project = service.resolveProject(projectId);
  const metadata = project?.metadata;
  if (!project || !isRecord(metadata) || metadata.foldy !== true || typeof metadata.entryFile !== 'string' || !metadata.entryFile) throw new HttpError(404, 'FOLDY_PROJECT_NOT_FOUND', 'formal Foldy project was not found');
  const declared = metadata.publicationFiles ?? [];
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === 'string')) {
    throw new HttpError(422, 'FOLDY_PUBLICATION_FILES_INVALID', 'publicationFiles must be an array of relative file paths');
  }
  return {
    project,
    entryFile: metadata.entryFile,
    publicationFiles: [...new Set([metadata.entryFile, ...declared])],
  };
}
function sendError(res: Response, error: unknown): void {
  if (error instanceof HttpError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
  if (typeof candidate?.status === 'number' && typeof candidate.code === 'string') { res.status(candidate.status).json({ error: { code: candidate.code, message: String(candidate.message), ...(candidate.details ? { details: candidate.details } : {}) } }); return; }
  res.status(500).json({ error: { code: 'FOLDY_MCP_INTERNAL_ERROR', message: 'Foldy MCP operation failed' } });
}
function wrap(handler: (req: Request, res: Response) => Promise<void> | void) { return async (req: Request, res: Response) => { try { await handler(req, res); } catch (error) { sendError(res, error); } }; }
function requireLocal(service: FoldyMcpRoutesService, req: Request): void { if (!service.isLocalAuthority(req)) throw new HttpError(403, 'FOLDY_MCP_ADMIN_LOCAL_ONLY', 'grant administration requires local authority'); }
function requireGrant(service: FoldyMcpRoutesService, req: Request, scope?: FoldyMcpScope): FoldyMcpGrant {
  const token = bearer(req);
  const grant = token ? service.grants.authenticate(token, undefined, scope) : null;
  if (!grant) throw new HttpError(scope ? 403 : 401, scope ? 'FOLDY_MCP_SCOPE_DENIED' : 'FOLDY_MCP_UNAUTHORIZED', scope ? `grant does not include ${scope}` : 'valid Foldy MCP bearer token required');
  formalProject(service, grant.projectId);
  return grant;
}
function rejectProjectOverride(input: Record<string, unknown>): void {
  if ('projectId' in input || 'project_id' in input || 'project' in input) throw new HttpError(400, 'FOLDY_MCP_PROJECT_FIXED', 'project is fixed by the grant and cannot be supplied by the caller');
}

export function registerFoldyMcpRoutes(app: Express, ctx: RegisterFoldyMcpRoutesDeps): void {
  const service = ctx.foldyMcp;
  app.post('/api/foldy/mcp/grants', wrap(async (req, res) => {
    requireLocal(service, req); const input = body(req);
    const projectId = text(input, 'projectId'); formalProject(service, projectId);
    if (!Array.isArray(input.scopes)) throw new HttpError(400, 'FOLDY_MCP_INVALID_REQUEST', 'scopes must be an array');
    const issued = await service.grants.create({ projectId, scopes: input.scopes as string[] });
    noStore(res); res.status(201).json({ ...issued, installInfo: createFoldyMcpInstallInfo({ command: service.command, daemonUrl: service.getDaemonUrl(), grantId: issued.grant.grantId }) });
  }));
  app.get('/api/foldy/mcp/grants', wrap((req, res) => { requireLocal(service, req); noStore(res); res.json({ grants: service.grants.list(typeof req.query.projectId === 'string' ? req.query.projectId : undefined) }); }));
  app.delete('/api/foldy/mcp/grants/:grantId', wrap(async (req, res) => { requireLocal(service, req); const revoked = await service.grants.revoke(String(req.params.grantId)); if (!revoked) throw new HttpError(404, 'FOLDY_MCP_GRANT_NOT_FOUND', 'grant not found'); noStore(res); res.json({ grant: revoked }); }));
  app.get('/api/foldy/mcp/grants/:grantId/install', wrap((req, res) => { requireLocal(service, req); const grant = service.grants.get(String(req.params.grantId)); if (!grant) throw new HttpError(404, 'FOLDY_MCP_GRANT_NOT_FOUND', 'grant not found'); noStore(res); res.json(createFoldyMcpInstallInfo({ command: service.command, daemonUrl: service.getDaemonUrl(), grantId: grant.grantId })); }));

  app.get('/api/foldy/mcp/session', wrap((req, res) => { const grant = requireGrant(service, req); noStore(res); res.json(grant); }));
  app.get('/api/foldy/mcp/resources', wrap(async (req, res) => { requireGrant(service, req, 'read'); res.json({ resources: [{ uri: 'foldy://project/publication', name: 'Publication state', mimeType: 'application/json' }] }); }));
  app.get('/api/foldy/mcp/resources/read', wrap(async (req, res) => {
    const grant = requireGrant(service, req, 'read');
    if (req.query.uri !== 'foldy://project/publication') throw new HttpError(404, 'FOLDY_MCP_RESOURCE_NOT_FOUND', 'resource not found');
    const state = await service.publicationStore.getState(grant.projectId);
    res.json({ contents: [{ uri: 'foldy://project/publication', mimeType: 'application/json', text: JSON.stringify(state) }] });
  }));

  const operations: Record<string, { scope: FoldyMcpScope; call(grant: FoldyMcpGrant, input: Record<string, unknown>): Promise<unknown> }> = {
    foldy_get_publication: { scope: 'read', call: async (grant) => service.publicationStore.getState(grant.projectId) },
    foldy_get_revision: { scope: 'read', call: async (grant, input) => service.publicationStore.getRevision(grant.projectId, text(input, 'revisionId')) },
    foldy_save_revision: { scope: 'editor', call: async (grant, input) => {
      const enrolled = formalProject(service, grant.projectId);
      if (text(input, 'entryFile') !== enrolled.entryFile) {
        throw new HttpError(422, 'FOLDY_ENTRY_IDENTITY_MISMATCH', 'revision entryFile must match the enrolled Foldy entry identity');
      }
      return service.publicationStore.saveRevision({
        projectId: grant.projectId,
        projectRoot: service.resolveProjectRoot(enrolled.project),
        entryFile: enrolled.entryFile,
        publicationFiles: enrolled.publicationFiles,
        expectedLatestRevisionId: input.expectedLatestRevisionId === null ? null : text(input, 'expectedLatestRevisionId'),
        actorId: `mcp:${grant.grantId}`,
      });
    } },
    foldy_request_review: { scope: 'reviewer', call: async (grant, input) => service.publicationStore.requestReview({ projectId: grant.projectId, revisionId: text(input, 'revisionId'), expectedLatestRevisionId: text(input, 'expectedLatestRevisionId'), actorId: `mcp:${grant.grantId}` }) },
    foldy_add_review_comment: { scope: 'reviewer', call: async (grant, input) => service.publicationStore.addReviewComment({ projectId: grant.projectId, revisionId: text(input, 'revisionId'), reviewId: text(input, 'reviewId'), body: text(input, 'body'), expectedReviewVersion: integer(input, 'expectedReviewVersion'), actorId: `mcp:${grant.grantId}` }) },
    foldy_decide_review: { scope: 'reviewer', call: async (grant, input) => { const decision = input.decision; if (decision !== 'approved' && decision !== 'changes_requested') throw new HttpError(400, 'FOLDY_MCP_INVALID_REQUEST', 'invalid decision'); return service.publicationStore.decideReview({ projectId: grant.projectId, revisionId: text(input, 'revisionId'), reviewId: text(input, 'reviewId'), decision, expectedReviewVersion: integer(input, 'expectedReviewVersion'), actorId: `mcp:${grant.grantId}` }); } },
    foldy_publish: { scope: 'publisher', call: async (grant, input) => service.publicationStore.publish({ projectId: grant.projectId, revisionId: text(input, 'revisionId'), expectedPublishedGeneration: integer(input, 'expectedPublishedGeneration'), actorId: `mcp:${grant.grantId}` }) },
    foldy_rollback: { scope: 'publisher', call: async (grant, input) => service.publicationStore.rollback({ projectId: grant.projectId, targetRevisionId: text(input, 'targetRevisionId'), expectedPublishedGeneration: integer(input, 'expectedPublishedGeneration'), actorId: `mcp:${grant.grantId}` }) },
    foldy_deploy: { scope: 'deployer', call: async (grant, input) => service.deploy(grant.projectId, input) },
  };
  app.post('/api/foldy/mcp/operations/:operation', wrap(async (req, res) => {
    const operation = operations[String(req.params.operation)]; if (!operation) throw new HttpError(404, 'FOLDY_MCP_OPERATION_NOT_FOUND', 'operation not found');
    const supplied = body(req); rejectProjectOverride(supplied); const grant = requireGrant(service, req, operation.scope);
    let input: Record<string, unknown>;
    try { input = validateFoldyMcpToolArguments(String(req.params.operation), supplied); }
    catch (error) {
      if (error instanceof FoldyMcpArgumentsError) throw new HttpError(400, 'FOLDY_MCP_INVALID_REQUEST', error.message);
      throw error;
    }
    res.json(await operation.call(grant, input));
  }));
}
