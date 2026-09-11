import type { Request, Express } from 'express';

import {
  FoldyPublicationStoreError,
  type FoldyPublicationStore,
} from '../foldy-publications/store.js';

interface FoldyProject {
  id: string;
  metadata?: unknown;
}

export interface FoldyPublicationRoutesService {
  publicationStore: Pick<FoldyPublicationStore,
    | 'getState'
    | 'getRevision'
    | 'saveRevision'
    | 'requestReview'
    | 'addReviewComment'
    | 'decideReview'
    | 'publish'
    | 'rollback'
    | 'resolvePublishedFile'>;
  resolveProject(projectId: string): FoldyProject | null;
  resolveProjectRoot(project: FoldyProject): string;
  resolveActorId(req: Request, projectId: string): string | Promise<string>;
}

export interface RegisterFoldyPublicationRoutesDeps {
  foldyPublication: FoldyPublicationRoutesService;
}

type JsonRecord = Record<string, unknown>;

class RouteInputError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteInputError(400, 'FOLDY_INVALID_REQUEST', 'request body must be a JSON object');
  }
  return value as JsonRecord;
}

function stringField(body: JsonRecord, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RouteInputError(400, 'FOLDY_INVALID_REQUEST', `${field} must be a non-empty string`);
  }
  return value;
}

function nonNegativeIntegerField(body: JsonRecord, field: string): number {
  const value = body[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RouteInputError(400, 'FOLDY_INVALID_REQUEST', `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableStringField(body: JsonRecord, field: string): string | null {
  const value = body[field];
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    throw new RouteInputError(400, 'FOLDY_INVALID_REQUEST', `${field} must be null or a non-empty string`);
  }
  return value as string | null;
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RouteInputError(400, 'FOLDY_INVALID_REQUEST', `${name} must be a non-empty path parameter`);
  }
  return value;
}

function formalFoldyProject(service: FoldyPublicationRoutesService, projectId: string): {
  project: FoldyProject;
  entryFile: string;
  publicationFiles: string[];
} {
  const project = service.resolveProject(projectId);
  const metadata = project?.metadata;
  if (!project || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new RouteInputError(404, 'FOLDY_PROJECT_NOT_FOUND', 'formal Foldy project was not found');
  }
  const candidate = metadata as JsonRecord;
  const entryFile = candidate.entryFile;
  if (candidate.foldy !== true || typeof entryFile !== 'string' || entryFile.length === 0) {
    throw new RouteInputError(404, 'FOLDY_PROJECT_NOT_FOUND', 'formal Foldy project was not found');
  }
  const declared = candidate.publicationFiles ?? [];
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === 'string')) {
    throw new RouteInputError(422, 'FOLDY_PUBLICATION_FILES_INVALID', 'publicationFiles must be an array of relative file paths');
  }
  return { project, entryFile, publicationFiles: [...new Set([entryFile, ...declared])] };
}

function sendError(res: any, error: unknown): unknown {
  if (error instanceof FoldyPublicationStoreError || error instanceof RouteInputError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...('details' in error && error.details ? { details: error.details } : {}),
      },
    });
  }
  const authorization = error as { status?: unknown; code?: unknown; message?: unknown };
  if (authorization?.status === 403 && typeof authorization.code === 'string') {
    return res.status(403).json({ error: { code: authorization.code, message: String(authorization.message) } });
  }
  return res.status(500).json({
    error: { code: 'FOLDY_INTERNAL_ERROR', message: 'Foldy publication operation failed' },
  });
}

function route(handler: (req: Request, res: any) => Promise<unknown>) {
  return async (req: Request, res: any): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

async function actor(service: FoldyPublicationRoutesService, req: Request): Promise<string> {
  const value = await service.resolveActorId(req, param(req, 'projectId'));
  if (typeof value !== 'string' || value.length === 0) {
    throw new RouteInputError(400, 'FOLDY_ACTOR_UNAVAILABLE', 'server could not resolve the local actor');
  }
  return value;
}

export function registerFoldyPublicationRoutes(
  app: Express,
  ctx: RegisterFoldyPublicationRoutesDeps,
): void {
  const service = ctx.foldyPublication;
  app.get('/api/projects/:projectId/publication', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    res.json(await service.publicationStore.getState(param(req, 'projectId')));
  }));

  app.post('/api/projects/:projectId/revisions', route(async (req, res) => {
    const enrolled = formalFoldyProject(service, param(req, 'projectId'));
    const body = record(req.body);
    const entryFile = stringField(body, 'entryFile');
    if (entryFile !== enrolled.entryFile) {
      throw new RouteInputError(422, 'FOLDY_ENTRY_IDENTITY_MISMATCH', 'revision entryFile must match the enrolled Foldy entry identity');
    }
    const revision = await service.publicationStore.saveRevision({
      projectId: param(req, 'projectId'),
      projectRoot: service.resolveProjectRoot(enrolled.project),
      entryFile,
      expectedLatestRevisionId: nullableStringField(body, 'expectedLatestRevisionId'),
      actorId: await actor(service, req),
      publicationFiles: enrolled.publicationFiles,
    });
    res.status(201).json(revision);
  }));

  app.get('/api/projects/:projectId/revisions/:revisionId', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    res.json(await service.publicationStore.getRevision(param(req, 'projectId'), param(req, 'revisionId')));
  }));

  app.post('/api/projects/:projectId/revisions/:revisionId/review', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    const body = record(req.body);
    const review = await service.publicationStore.requestReview({
      projectId: param(req, 'projectId'),
      revisionId: param(req, 'revisionId'),
      expectedLatestRevisionId: stringField(body, 'expectedLatestRevisionId'),
      actorId: await actor(service, req),
    });
    res.status(201).json(review);
  }));

  app.post('/api/projects/:projectId/revisions/:revisionId/reviews/:reviewId/comments', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    const body = record(req.body);
    const comment = await service.publicationStore.addReviewComment({
      projectId: param(req, 'projectId'),
      revisionId: param(req, 'revisionId'),
      reviewId: param(req, 'reviewId'),
      body: stringField(body, 'body'),
      expectedReviewVersion: nonNegativeIntegerField(body, 'expectedReviewVersion'),
      actorId: await actor(service, req),
    });
    res.status(201).json(comment);
  }));

  app.post('/api/projects/:projectId/revisions/:revisionId/reviews/:reviewId/decision', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    const body = record(req.body);
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'changes_requested') {
      throw new RouteInputError(422, 'FOLDY_REVIEW_DECISION_INVALID', 'decision must be approved or changes_requested');
    }
    res.json(await service.publicationStore.decideReview({
      projectId: param(req, 'projectId'),
      revisionId: param(req, 'revisionId'),
      reviewId: param(req, 'reviewId'),
      decision,
      expectedReviewVersion: nonNegativeIntegerField(body, 'expectedReviewVersion'),
      actorId: await actor(service, req),
    }));
  }));

  app.post('/api/projects/:projectId/publication/publish', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    const body = record(req.body);
    res.json(await service.publicationStore.publish({
      projectId: param(req, 'projectId'),
      revisionId: stringField(body, 'revisionId'),
      expectedPublishedGeneration: nonNegativeIntegerField(body, 'expectedPublishedGeneration'),
      actorId: await actor(service, req),
    }));
  }));

  app.post('/api/projects/:projectId/publication/rollback', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    const body = record(req.body);
    res.json(await service.publicationStore.rollback({
      projectId: param(req, 'projectId'),
      targetRevisionId: stringField(body, 'targetRevisionId'),
      expectedPublishedGeneration: nonNegativeIntegerField(body, 'expectedPublishedGeneration'),
      actorId: await actor(service, req),
    }));
  }));

  // OpenDesign 0.7 is on Express 4/path-to-regexp 0.x. Its wildcard capture is
  // exposed as params[0]; the Express 5 `*path` syntax does not match here.
  app.get('/p/:projectId/*', route(async (req, res) => {
    formalFoldyProject(service, param(req, 'projectId'));
    const requestedPath = req.params[0] ?? '';
    const file = await service.publicationStore.resolvePublishedFile(param(req, 'projectId'), requestedPath);
    const etag = `"sha256-${file.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, no-cache, must-revalidate');
    if (req.headers['if-none-match']?.split(',').map((value) => value.trim()).includes(etag)) {
      res.status(304).end();
      return;
    }
    res.type(file.path).send(file.bytes);
  }));
}
