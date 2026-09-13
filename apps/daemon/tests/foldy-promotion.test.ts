import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import type http from 'node:http';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  assertGenericFoldyFileMutationAllowed,
  assertGenericFoldyMetadataPatchAllowed,
  canonicalFoldyReceiptPayload,
  FoldyPromotionError,
  hashBundle,
  hashProtectedSurfaceContract,
  enrollLegacyFoldyBaseline,
  parseFoldyLegacyBaselineEnrollmentRequest,
  parseFoldyNoProtectedAncestorRepairRequest,
  promoteFoldy,
  repairFoldyNoProtectedAncestor,
  withGenericFoldyFileMutation,
  type FoldyProjectMetadata,
  type FoldyPromotionRequest,
  type FoldyReceipt,
} from '../src/foldy-promotion.js';
import { registerProjectRoutes } from '../src/project-routes.js';
import { FoldyPublicationStore } from '../src/foldy-publications/store.js';
import { registerFoldyPublicationRoutes } from '../src/routes/foldy-publication.js';

const roots: string[] = [];
const projectId = 'foldy-project';
const currentRevisionId = 'rev_000001';
const candidateRevisionId = 'rev_000002';
const entryFile = 'index.html';
const rootFiles = ['workbook.json', entryFile, `${entryFile}.artifact.json`];
let wrenPrivateKey: KeyObject;
let assurancePrivateKey: KeyObject;
let priorWrenKey: string | undefined;
let priorAssuranceKey: string | undefined;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameMetadata(left: FoldyProjectMetadata, right: FoldyProjectMetadata): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function signedReceipt(
  kind: FoldyReceipt['kind'],
  reviewer: string,
  key: KeyObject,
  binding: Pick<FoldyReceipt,
    'project_id' | 'workbook_id' | 'baseline_revision_id' | 'candidate_revision_id' |
    'contract' | 'bundle_sha256' | 'protected_manifest_sha256'>,
): FoldyReceipt {
  const unsigned: Omit<FoldyReceipt, 'signature'> = {
    kind,
    reviewer,
    decision: 'PASS',
    ...binding,
    nonce: `nonce-${randomUUID()}`,
    task_id: 'task-123',
    session_id: 'session-123',
    run_id: 'run-123',
    issued_at: '2026-08-27T12:00:00.000Z',
  };
  return {
    ...unsigned,
    signature: sign(null, canonicalFoldyReceiptPayload(unsigned), key).toString('base64'),
  };
}

async function makeRoot(): Promise<string> {
  const root = path.join(process.cwd(), `.foldy-promotion-test-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: false });
  return root;
}

async function filesAt(root: string, files: string[]): Promise<Array<{ path: string; bytes: Buffer }>> {
  return Promise.all(files.map(async (logicalPath) => ({
    path: logicalPath,
    bytes: await readFile(path.join(root, logicalPath)),
  })));
}

type Fixture = {
  root: string;
  metadata: FoldyProjectMetadata;
  metadataStore: { current: FoldyProjectMetadata };
  request: FoldyPromotionRequest;
  priorRoot: Record<string, Buffer>;
  candidateBefore: Record<string, Buffer>;
  metadataWrites: FoldyProjectMetadata[];
};

async function fixture(): Promise<Fixture> {
  const root = await makeRoot();
  const baselineRoot = path.join(root, 'revisions', currentRevisionId);
  const candidateRoot = path.join(root, 'revisions', candidateRevisionId);
  await mkdir(baselineRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });

  const priorRoot: Record<string, Buffer> = {
    'workbook.json': Buffer.from('{"prior":true}'),
    'index.html': Buffer.from('<main>prior</main>'),
    'index.html.artifact.json': Buffer.from('{"metadata":{"revisionId":"rev_000001"}}'),
  };
  for (const [logicalPath, bytes] of Object.entries(priorRoot)) await writeFile(path.join(root, logicalPath), bytes);
  await writeFile(path.join(root, 'protected-brand.css'), ':root{--brand:#123456}');
  const protectedSurfaces = [{
    path: 'protected-brand.css',
    sha256: sha256(await readFile(path.join(root, 'protected-brand.css'))),
  }];

  const baselineWorkbook = {
    schemaVersion: '1.0',
    workbookId: 'workbook_alpha',
    revisions: [{
      revisionId: currentRevisionId,
      state: 'FROZEN',
      bundleSha256: '1'.repeat(64),
      protectedSurfaces,
    }],
  };
  await writeFile(path.join(baselineRoot, 'workbook.json'), JSON.stringify(baselineWorkbook));

  const candidateWorkbook = {
    schemaVersion: '1.0',
    workbookId: 'workbook_alpha',
    revisions: [
      baselineWorkbook.revisions[0],
      { revisionId: candidateRevisionId, state: 'FROZEN', bundleSha256: null as string | null },
    ],
  };
  await writeFile(path.join(candidateRoot, 'workbook.json'), JSON.stringify(candidateWorkbook));
  await writeFile(path.join(candidateRoot, 'index.html'), '<main>candidate</main>');
  await writeFile(path.join(candidateRoot, 'index.html.artifact.json'), JSON.stringify({ metadata: { revisionId: candidateRevisionId } }));
  const candidateBundleSha256 = hashBundle(await filesAt(candidateRoot, rootFiles));
  candidateWorkbook.revisions[1]!.bundleSha256 = candidateBundleSha256;
  await writeFile(path.join(candidateRoot, 'workbook.json'), JSON.stringify(candidateWorkbook));
  expect(hashBundle(await filesAt(candidateRoot, rootFiles))).toBe(candidateBundleSha256);

  const requestRootFiles = [...rootFiles];
  const receiptBinding = {
    project_id: projectId,
    workbook_id: 'workbook_alpha',
    baseline_revision_id: currentRevisionId,
    candidate_revision_id: candidateRevisionId,
    contract: { version: 'foldy-promotion.v1' as const, entry_file: entryFile, root_files: requestRootFiles },
    bundle_sha256: candidateBundleSha256,
    protected_manifest_sha256: hashProtectedSurfaceContract(protectedSurfaces),
  };
  const request: FoldyPromotionRequest = {
    version: 'foldy-promotion.v1',
    expectedCurrentRevisionId: currentRevisionId,
    candidateRevisionId,
    candidateBundleSha256,
    entryFile,
    rootFiles: requestRootFiles,
    protectedSurfaces,
    wrenReceipt: signedReceipt('foldy-wren-review.v1', 'wren-ashford', wrenPrivateKey, receiptBinding),
    assuranceReceipt: signedReceipt('foldy-assurance.v1', 'independent-reviewer', assurancePrivateKey, receiptBinding),
  };
  const metadata: FoldyProjectMetadata = {
    foldy: true,
    workbookId: 'workbook_alpha',
    revisionId: currentRevisionId,
    currentRevisionId,
    entryFile,
  };
  const metadataStore = { current: structuredClone(metadata) };
  const candidateBefore = Object.fromEntries(await Promise.all(rootFiles.map(async (logicalPath) => [
    logicalPath,
    await readFile(path.join(candidateRoot, logicalPath)),
  ])));
  return { root, metadata, metadataStore, request, priorRoot, candidateBefore, metadataWrites: [] };
}

async function runPromotion(f: Fixture, hooks?: Parameters<typeof promoteFoldy>[0]['hooks']) {
  return promoteFoldy({
    projectId,
    projectRoot: f.root,
    request: f.request,
    ...(hooks ? { hooks } : {}),
    readProjectMetadata: () => structuredClone(f.metadataStore.current),
    compareAndSetProjectMetadata: (expected, replacement) => {
      if (!sameMetadata(f.metadataStore.current, expected)) return false;
      f.metadataStore.current = structuredClone(replacement);
      f.metadataWrites.push(structuredClone(replacement));
      return true;
    },
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'FoldyPromotionError', code });
}

async function invokeProjectPatchRoute(input: {
  root: string;
  metadata: FoldyProjectMetadata | null;
  patch: Record<string, unknown>;
  beforeCas?: (project: any) => void;
}): Promise<{ status: number; body: any; metadata: FoldyProjectMetadata | null }> {
  let project: any = {
    id: projectId,
    name: 'Foldy route fixture',
    metadata: structuredClone(input.metadata),
    createdAt: 1,
    updatedAt: 1,
  };
  let patchHandler: ((req: any, res: any) => Promise<unknown>) | undefined;
  const app: any = {};
  for (const method of ['get', 'post', 'patch', 'delete', 'put', 'options']) {
    app[method] = (route: string, ...handlers: Array<(...args: any[]) => unknown>) => {
      if (method === 'patch' && route === '/api/projects/:id') patchHandler = handlers.at(-1) as typeof patchHandler;
      return app;
    };
  }
  const db = {
    prepare: () => ({
      run: (replacementJson: string | null, _updatedAt: number, id: string, expectedJson: string | null) => {
        input.beforeCas?.(project);
        const actualJson = project.metadata ? JSON.stringify(project.metadata) : null;
        if (id !== project.id || actualJson !== expectedJson) return { changes: 0 };
        project.metadata = replacementJson ? JSON.parse(replacementJson) : undefined;
        return { changes: 1 };
      },
    }),
  };
  const inert = () => undefined;
  registerProjectRoutes(app, {
    db,
    design: { runs: { list: () => [], isTerminal: () => true } },
    http: {
      sendApiError: (res: any, status: number, code: string, message: string, extra?: Record<string, unknown>) =>
        res.status(status).json({ error: { code, message, ...extra } }),
      createSseResponse: inert,
    },
    paths: { DESIGN_SYSTEMS_DIR: '', PROJECTS_DIR: '', SKILLS_DIR: '' },
    projectStore: {
      insertProject: inert,
      validateLinkedDirs: (dirs: unknown[]) => ({ dirs }),
      getProject: (_db: unknown, id: string) => id === project.id ? structuredClone(project) : null,
      updateProject: (_db: unknown, id: string, patch: Record<string, unknown>) => {
        if (id !== project.id) return null;
        project = { ...project, ...structuredClone(patch) };
        return structuredClone(project);
      },
      dbDeleteProject: inert,
      removeProjectDir: inert,
    },
    projectFiles: {
      writeProjectFile: inert,
      readProjectFile: inert,
      ensureProject: inert,
      listFiles: () => [],
      listTabs: inert,
      setTabs: inert,
      resolveProjectDir: () => input.root,
    },
    conversations: new Proxy({}, { get: () => inert }),
    templates: new Proxy({}, { get: () => inert }),
    status: {
      listLatestProjectRunStatuses: () => new Map(),
      listProjectsAwaitingInput: () => new Set(),
      normalizeProjectDisplayStatus: inert,
      composeProjectDisplayStatus: inert,
      listProjects: () => [],
    },
    events: { subscribeFileEvents: inert, activeProjectEventSinks: new Map() },
    ids: { randomId: () => 'id' },
    telemetry: {},
  } as any);
  if (!patchHandler) throw new Error('PATCH /api/projects/:id was not registered');
  const response = { status: 200, body: undefined as any };
  const res = {
    status(code: number) { response.status = code; return this; },
    json(body: any) { response.body = body; return this; },
  };
  await patchHandler({ params: { id: projectId }, body: input.patch }, res);
  return { ...response, metadata: project.metadata ?? null };
}

async function invokeProjectCreateRoute(metadata: unknown): Promise<{
  status: number;
  body: any;
  insertedProject: any;
}> {
  let createHandler: ((req: any, res: any) => Promise<unknown>) | undefined;
  let insertedProject: any = null;
  const app: any = {};
  for (const method of ['get', 'post', 'patch', 'delete', 'put', 'options']) {
    app[method] = (route: string, ...handlers: Array<(...args: any[]) => unknown>) => {
      if (method === 'post' && route === '/api/projects') createHandler = handlers.at(-1) as typeof createHandler;
      return app;
    };
  }
  const inert = () => undefined;
  registerProjectRoutes(app, {
    db: {},
    design: { runs: { list: () => [], isTerminal: () => true } },
    http: {
      sendApiError: (res: any, status: number, code: string, message: string, extra?: Record<string, unknown>) =>
        res.status(status).json({ error: { code, message, ...extra } }),
      createSseResponse: inert,
    },
    paths: { DESIGN_SYSTEMS_DIR: '', PROJECTS_DIR: '', SKILLS_DIR: '' },
    projectStore: {
      insertProject: (_db: unknown, project: Record<string, unknown>) => {
        insertedProject = structuredClone(project);
        return structuredClone(project);
      },
      validateLinkedDirs: (dirs: unknown[]) => ({ dirs }),
      getProject: () => insertedProject ? structuredClone(insertedProject) : null,
      updateProject: inert,
      dbDeleteProject: inert,
      removeProjectDir: inert,
    },
    projectFiles: {
      writeProjectFile: inert,
      readProjectFile: inert,
      ensureProject: inert,
      listFiles: () => [],
      listTabs: inert,
      setTabs: inert,
      resolveProjectDir: () => '',
    },
    conversations: new Proxy({}, { get: () => inert }),
    templates: new Proxy({}, { get: () => inert }),
    status: {
      listLatestProjectRunStatuses: () => new Map(),
      listProjectsAwaitingInput: () => new Set(),
      normalizeProjectDisplayStatus: inert,
      composeProjectDisplayStatus: inert,
      listProjects: () => [],
    },
    events: { subscribeFileEvents: inert, activeProjectEventSinks: new Map() },
    ids: { randomId: () => 'conversation-id' },
    telemetry: {},
  } as any);
  if (!createHandler) throw new Error('POST /api/projects was not registered');
  const response = { status: 200, body: undefined as any };
  const res = {
    status(code: number) { response.status = code; return this; },
    json(body: any) { response.body = body; return this; },
  };
  await createHandler({ body: { id: projectId, name: 'Foldy route fixture', metadata } }, res);
  return { ...response, insertedProject };
}

async function invokeLegacyEnrollmentRoute(input: {
  root: string;
  metadata: FoldyProjectMetadata;
  body: unknown;
}): Promise<{ status: number; body: any; metadata: FoldyProjectMetadata }> {
  let project: any = {
    id: projectId,
    name: 'Legacy Foldy route fixture',
    metadata: structuredClone(input.metadata),
  };
  let handler: ((req: any, res: any) => Promise<unknown>) | undefined;
  const app: any = {};
  for (const method of ['get', 'post', 'patch', 'delete', 'put', 'options']) {
    app[method] = (route: string, ...handlers: Array<(...args: any[]) => unknown>) => {
      if (method === 'post' && route === '/api/projects/:id/foldy/enroll-legacy-baseline') {
        handler = handlers.at(-1) as typeof handler;
      }
      return app;
    };
  }
  const db = {
    prepare: () => ({
      run: (replacementJson: string, _updatedAt: number, id: string, expectedJson: string) => {
        if (id !== project.id || JSON.stringify(project.metadata) !== expectedJson) return { changes: 0 };
        project.metadata = JSON.parse(replacementJson);
        return { changes: 1 };
      },
    }),
  };
  const inert = () => undefined;
  registerProjectRoutes(app, {
    db,
    design: { runs: { list: () => [], isTerminal: () => true } },
    http: {
      sendApiError: (res: any, status: number, code: string, message: string, extra?: Record<string, unknown>) =>
        res.status(status).json({ error: { code, message, ...extra } }),
      createSseResponse: inert,
    },
    paths: { DESIGN_SYSTEMS_DIR: '', PROJECTS_DIR: '', SKILLS_DIR: '' },
    projectStore: {
      insertProject: inert,
      validateLinkedDirs: (dirs: unknown[]) => ({ dirs }),
      getProject: (_db: unknown, id: string) => id === project.id ? structuredClone(project) : null,
      updateProject: inert,
      dbDeleteProject: inert,
      removeProjectDir: inert,
    },
    projectFiles: {
      writeProjectFile: inert,
      readProjectFile: inert,
      ensureProject: inert,
      listFiles: () => [],
      listTabs: inert,
      setTabs: inert,
      resolveProjectDir: () => input.root,
    },
    conversations: new Proxy({}, { get: () => inert }),
    templates: new Proxy({}, { get: () => inert }),
    status: {
      listLatestProjectRunStatuses: () => new Map(),
      listProjectsAwaitingInput: () => new Set(),
      normalizeProjectDisplayStatus: inert,
      composeProjectDisplayStatus: inert,
      listProjects: () => [],
    },
    events: { subscribeFileEvents: inert, activeProjectEventSinks: new Map() },
    ids: { randomId: () => 'id' },
    telemetry: {},
  } as any);
  if (!handler) throw new Error('legacy Foldy enrollment route was not registered');
  const response = { status: 200, body: undefined as any };
  const res = {
    status(code: number) { response.status = code; return this; },
    json(body: any) { response.body = body; return this; },
  };
  await handler({ params: { id: projectId }, body: input.body }, res);
  return { ...response, metadata: project.metadata };
}

beforeAll(() => {
  priorWrenKey = process.env.OD_FOLDY_WREN_PUBLIC_KEY;
  priorAssuranceKey = process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY;
  const wren = generateKeyPairSync('ed25519');
  const assurance = generateKeyPairSync('ed25519');
  wrenPrivateKey = wren.privateKey;
  assurancePrivateKey = assurance.privateKey;
  process.env.OD_FOLDY_WREN_PUBLIC_KEY = wren.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY = assurance.publicKey.export({ format: 'pem', type: 'spki' }).toString();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(() => {
  if (priorWrenKey === undefined) delete process.env.OD_FOLDY_WREN_PUBLIC_KEY;
  else process.env.OD_FOLDY_WREN_PUBLIC_KEY = priorWrenKey;
  if (priorAssuranceKey === undefined) delete process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY;
  else process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY = priorAssuranceKey;
});

describe('provider-side Foldy promotion gate', () => {
  it('promotes only a signed candidate bound to the frozen protected baseline', async () => {
    const f = await fixture();
    await expect(runPromotion(f)).resolves.toMatchObject({
      ok: true,
      priorRevisionId: currentRevisionId,
      currentRevisionId: candidateRevisionId,
      pointerParityVerified: true,
      protectedSurfacesVerified: 1,
    });
    for (const logicalPath of rootFiles) expect(await readFile(path.join(f.root, logicalPath))).toEqual(f.candidateBefore[logicalPath]);
    expect(f.metadataStore.current).toMatchObject({
      revisionId: candidateRevisionId,
      currentRevisionId: candidateRevisionId,
      publicationFiles: ['workbook.json', 'index.html', 'index.html.artifact.json'],
    });
    expect((f.metadataStore.current.publicationFiles as string[]).filter((file) => file === entryFile)).toHaveLength(1);
  });

  it('carries the promoted root-file closure through immutable save, publish, and serving', async () => {
    const f = await fixture();
    const candidateRoot = path.join(f.root, 'revisions', candidateRevisionId);
    const dependencies: Record<string, string> = {
      'styles/site.css': '@font-face{src:url(../assets/site.woff2)}main{background:url(../assets/bg.png)}',
      'assets/site.woff2': 'font-bytes',
      'assets/bg.png': 'image-bytes',
      'scripts/app.js': 'import { boot } from "./boot.js"; boot();',
      'scripts/boot.js': 'export const boot = () => {};',
      'pages/about.html': '<h1>About</h1>',
    };
    await writeFile(path.join(candidateRoot, entryFile), [
      '<link rel="stylesheet" href="./styles/site.css">',
      '<script type="module" src="./scripts/app.js"></script>',
      '<a href="./pages/about.html">About</a>',
      '<img src="data:image/png;base64,AAAA"><img src="../../../escape.png">',
      '<script src="https://cdn.example/app.js"></script>',
    ].join(''));
    for (const [logicalPath, contents] of Object.entries(dependencies)) {
      await mkdir(path.dirname(path.join(candidateRoot, logicalPath)), { recursive: true });
      await writeFile(path.join(candidateRoot, logicalPath), contents);
      f.request.rootFiles.push(logicalPath);
    }
    const workbookPath = path.join(candidateRoot, 'workbook.json');
    const workbook = JSON.parse(await readFile(workbookPath, 'utf8'));
    workbook.revisions.at(-1).bundleSha256 = null;
    await writeFile(workbookPath, JSON.stringify(workbook));
    f.request.candidateBundleSha256 = hashBundle(await filesAt(candidateRoot, f.request.rootFiles));
    workbook.revisions.at(-1).bundleSha256 = f.request.candidateBundleSha256;
    await writeFile(workbookPath, JSON.stringify(workbook));
    const binding = {
      project_id: projectId,
      workbook_id: 'workbook_alpha',
      baseline_revision_id: currentRevisionId,
      candidate_revision_id: candidateRevisionId,
      contract: { version: 'foldy-promotion.v1' as const, entry_file: entryFile, root_files: f.request.rootFiles },
      bundle_sha256: f.request.candidateBundleSha256,
      protected_manifest_sha256: hashProtectedSurfaceContract(f.request.protectedSurfaces),
    };
    f.request.wrenReceipt = signedReceipt('foldy-wren-review.v1', 'wren-ashford', wrenPrivateKey, binding);
    f.request.assuranceReceipt = signedReceipt('foldy-assurance.v1', 'independent-reviewer', assurancePrivateKey, binding);
    await runPromotion(f);
    expect(f.metadataStore.current.publicationFiles).toEqual(f.request.rootFiles);

    let publicationId = 0;
    const store = new FoldyPublicationStore({
      rootDir: path.join(f.root, '.publication-store'),
      randomId: () => `publication_${++publicationId}`,
    });
    const revision = await store.saveRevision({
      projectId,
      projectRoot: f.root,
      entryFile,
      publicationFiles: f.metadataStore.current.publicationFiles!,
      expectedLatestRevisionId: null,
      actorId: 'author',
    });
    expect(revision.files.map((file) => file.path)).toEqual([...f.request.rootFiles].sort((a, b) => a.localeCompare(b)));
    let review = await store.requestReview({ projectId, revisionId: revision.revisionId, expectedLatestRevisionId: revision.revisionId, actorId: 'author' });
    review = await store.decideReview({ projectId, revisionId: revision.revisionId, reviewId: review.reviewId, expectedReviewVersion: review.version, decision: 'approved', actorId: 'reviewer' });
    expect(review.status).toBe('approved');
    await store.publish({ projectId, revisionId: revision.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' });

    const app = express();
    registerFoldyPublicationRoutes(app, { foldyPublication: {
      publicationStore: store,
      resolveProject: (id) => id === projectId ? { id, metadata: f.metadataStore.current } : null,
      resolveProjectRoot: () => f.root,
      resolveActorId: () => 'actor',
    } });
    const server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      for (const logicalPath of f.request.rootFiles) {
        const response = await fetch(`http://127.0.0.1:${address.port}/p/${projectId}/${logicalPath}`);
        expect(response.status, logicalPath).toBe(200);
      }
      for (const rejected of ['escape.png', 'unrelated.txt']) {
        expect((await fetch(`http://127.0.0.1:${address.port}/p/${projectId}/${rejected}`)).status).toBe(404);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects caller-forged Wren and assurance receipt fields', async () => {
    const forgedWren = await fixture();
    forgedWren.request.wrenReceipt.task_id = 'task-forged';
    await expectCode(runPromotion(forgedWren), 'FOLDY_INVALID_RECEIPT_SIGNATURE');

    const forgedAssurance = await fixture();
    forgedAssurance.request.assuranceReceipt.run_id = 'run-forged';
    await expectCode(runPromotion(forgedAssurance), 'FOLDY_INVALID_RECEIPT_SIGNATURE');
  });

  it('fails closed when either server-owned Ed25519 public key is unavailable', async () => {
    const f = await fixture();
    const key = process.env.OD_FOLDY_WREN_PUBLIC_KEY;
    delete process.env.OD_FOLDY_WREN_PUBLIC_KEY;
    try {
      await expectCode(runPromotion(f), 'FOLDY_RECEIPT_KEYS_UNAVAILABLE');
    } finally {
      process.env.OD_FOLDY_WREN_PUBLIC_KEY = key;
    }
  });

  it('rejects caller-selected and empty protected baselines', async () => {
    const selected = await fixture();
    selected.request.protectedSurfaces[0]!.sha256 = '0'.repeat(64);
    await expectCode(runPromotion(selected), 'FOLDY_PROTECTED_BASELINE_MISMATCH');

    const emptyRequest = await fixture();
    emptyRequest.request.protectedSurfaces = [];
    await expectCode(runPromotion(emptyRequest), 'FOLDY_INVALID_REQUEST');

    const emptyServerBaseline = await fixture();
    const baselinePath = path.join(emptyServerBaseline.root, 'revisions', currentRevisionId, 'workbook.json');
    const workbook = JSON.parse(await readFile(baselinePath, 'utf8'));
    workbook.revisions[0].protectedSurfaces = [];
    await writeFile(baselinePath, JSON.stringify(workbook));
    await expectCode(runPromotion(emptyServerBaseline), 'FOLDY_PROTECTED_BASELINE_REQUIRED');
  });

  it('blocks generic metadata PATCH from stripping or retargeting the Foldy envelope', async () => {
    const f = await fixture();
    await expectCode(assertGenericFoldyMetadataPatchAllowed(f.root, f.metadata, { custom: true }), 'FOLDY_PROMOTION_REQUIRED');
    await expectCode(assertGenericFoldyMetadataPatchAllowed(f.root, f.metadata, {
      ...f.metadata,
      entryFile: 'attacker.html',
    }), 'FOLDY_PROMOTION_REQUIRED');
  });

  it('rejects null and primitive metadata bypasses for an existing Foldy project', async () => {
    const f = await fixture();
    await expectCode(assertGenericFoldyMetadataPatchAllowed(f.root, f.metadata, null), 'FOLDY_PROMOTION_REQUIRED');
    await expectCode(assertGenericFoldyMetadataPatchAllowed(f.root, f.metadata, 'not-an-object'), 'FOLDY_PROMOTION_REQUIRED');

    const nullRoute = await invokeProjectPatchRoute({ root: f.root, metadata: f.metadata, patch: { metadata: null } });
    expect(nullRoute.status).toBe(409);
    expect(nullRoute.body.error.code).toBe('FOLDY_PROMOTION_REQUIRED');
    expect(nullRoute.metadata).toEqual(f.metadata);

    const primitiveRoute = await invokeProjectPatchRoute({ root: f.root, metadata: f.metadata, patch: { metadata: 7 } });
    expect(primitiveRoute.status).toBe(409);
    expect(primitiveRoute.body.error.code).toBe('FOLDY_PROMOTION_REQUIRED');
  });

  it('rejects Foldy enrollment fields through generic project creation', async () => {
    const enrollmentValues: Record<string, unknown> = {
      foldy: false,
      workbookId: null,
      revisionId: currentRevisionId,
      currentRevisionId,
    };
    for (const [field, value] of Object.entries(enrollmentValues)) {
      const route = await invokeProjectCreateRoute({ kind: 'prototype', [field]: value });
      expect(route.status).toBe(409);
      expect(route.body.error.code).toBe('FOLDY_PROMOTION_REQUIRED');
      expect(route.insertedProject).toBeNull();
    }

    const ordinary = await invokeProjectCreateRoute({ custom: 'ordinary' });
    expect(ordinary.status).toBe(200);
    expect(ordinary.insertedProject?.metadata).toEqual({ custom: 'ordinary' });
  });

  it('rejects generic metadata and workbook bootstrap of a non-Foldy project', async () => {
    const root = await makeRoot();
    await expectCode(assertGenericFoldyMetadataPatchAllowed(root, { kind: 'prototype' }, {
      kind: 'prototype',
      foldy: true,
      workbookId: 'workbook_alpha',
      revisionId: currentRevisionId,
    }), 'FOLDY_PROMOTION_REQUIRED');
    await expectCode(assertGenericFoldyFileMutationAllowed({
      projectRoot: root,
      metadata: { kind: 'prototype' },
      logicalPath: 'workbook.json',
      operation: 'write',
      incomingBytes: Buffer.from(JSON.stringify({ workbookId: 'workbook_alpha', revisions: [] })),
    }), 'FOLDY_PROMOTION_REQUIRED');

    const route = await invokeProjectPatchRoute({
      root,
      metadata: { kind: 'prototype' },
      patch: { metadata: { kind: 'prototype', foldy: true, workbookId: 'workbook_alpha', revisionId: currentRevisionId } },
    });
    expect(route.status).toBe(409);
    expect(route.body.error.code).toBe('FOLDY_PROMOTION_REQUIRED');
    expect(route.metadata).toEqual({ kind: 'prototype' });
  });

  it('uses metadata compare-and-set on generic PATCH and preserves a concurrent winner', async () => {
    const f = await fixture();
    let injected = false;
    const route = await invokeProjectPatchRoute({
      root: f.root,
      metadata: f.metadata,
      patch: { metadata: { ...f.metadata, custom: 'generic-edit' } },
      beforeCas: (project) => {
        if (!injected) {
          injected = true;
          project.metadata = { ...project.metadata, concurrentWinner: true };
        }
      },
    });
    expect(route.status).toBe(409);
    expect(route.body.error.code).toBe('FOLDY_METADATA_CAS_FAILED');
    expect(route.metadata).toMatchObject({ concurrentWinner: true });
    expect(route.metadata).not.toHaveProperty('custom');
  });

  it('requires cryptographically distinct Wren and assurance public keys', async () => {
    const f = await fixture();
    const assuranceKey = process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY;
    process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY = process.env.OD_FOLDY_WREN_PUBLIC_KEY;
    try {
      await expectCode(runPromotion(f), 'FOLDY_RECEIPT_KEYS_NOT_INDEPENDENT');
    } finally {
      process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY = assuranceKey;
    }
  });

  it('serializes generic Foldy mutations behind promotion and re-reads promoted metadata', async () => {
    const f = await fixture();
    let releasePromotion!: () => void;
    const promotionBlocked = new Promise<void>((resolve) => { releasePromotion = resolve; });
    let promotionReachedHook!: () => void;
    const hookReached = new Promise<void>((resolve) => { promotionReachedHook = resolve; });
    const promotion = runPromotion(f, {
      async afterRootWrite(logicalPath) {
        if (logicalPath === rootFiles[0]) {
          promotionReachedHook();
          await promotionBlocked;
        }
      },
    });
    await hookReached;
    let observedRevision: string | undefined;
    const genericMutation = withGenericFoldyFileMutation({
      projectId,
      projectRoot: f.root,
      readProjectMetadata: () => structuredClone(f.metadataStore.current),
      logicalPath: 'notes.txt',
      operation: 'write',
      incomingBytes: Buffer.from('notes'),
      mutate: async (_guard, metadata) => {
        observedRevision = metadata?.currentRevisionId;
        await writeFile(path.join(f.root, 'notes.txt'), 'notes');
      },
    });
    await Promise.resolve();
    expect(observedRevision).toBeUndefined();
    releasePromotion();
    await Promise.all([promotion, genericMutation]);
    expect(observedRevision).toBe(candidateRevisionId);
  });

  it('re-reads metadata under the lock and rolls root files back when CAS detects concurrent metadata', async () => {
    const f = await fixture();
    await expectCode(runPromotion(f, {
      afterRootWrite(logicalPath) {
        if (logicalPath === rootFiles.at(-1)) f.metadataStore.current = { ...f.metadataStore.current, concurrentEdit: true };
      },
    }), 'FOLDY_METADATA_CAS_FAILED');
    for (const logicalPath of rootFiles) expect(await readFile(path.join(f.root, logicalPath))).toEqual(f.priorRoot[logicalPath]);
    expect(f.metadataStore.current.concurrentEdit).toBe(true);
  });

  it('rejects a stale baseline observed by a second queued promotion', async () => {
    const first = await fixture();
    const secondRequest = structuredClone(first.request);
    await runPromotion(first);
    first.request = secondRequest;
    await expectCode(runPromotion(first), 'FOLDY_STALE_CURRENT');
  });

  it('rejects symlink ancestors before root pointer writes', async () => {
    const f = await fixture();
    const candidateRoot = path.join(f.root, 'revisions', candidateRevisionId);
    await mkdir(path.join(candidateRoot, 'assets'));
    await writeFile(path.join(candidateRoot, 'assets', 'pointer.txt'), 'candidate asset');
    f.request.rootFiles.push('assets/pointer.txt');
    const workbookPath = path.join(candidateRoot, 'workbook.json');
    const workbook = JSON.parse(await readFile(workbookPath, 'utf8'));
    workbook.revisions[1].bundleSha256 = null;
    await writeFile(workbookPath, JSON.stringify(workbook));
    f.request.candidateBundleSha256 = hashBundle(await filesAt(candidateRoot, f.request.rootFiles));
    workbook.revisions[1].bundleSha256 = f.request.candidateBundleSha256;
    await writeFile(workbookPath, JSON.stringify(workbook));
    const receiptBinding = {
      project_id: projectId,
      workbook_id: 'workbook_alpha',
      baseline_revision_id: currentRevisionId,
      candidate_revision_id: candidateRevisionId,
      contract: {
        version: 'foldy-promotion.v1' as const,
        entry_file: entryFile,
        root_files: f.request.rootFiles,
      },
      bundle_sha256: f.request.candidateBundleSha256,
      protected_manifest_sha256: hashProtectedSurfaceContract(f.request.protectedSurfaces),
    };
    f.request.wrenReceipt = signedReceipt('foldy-wren-review.v1', 'wren-ashford', wrenPrivateKey, receiptBinding);
    f.request.assuranceReceipt = signedReceipt('foldy-assurance.v1', 'independent-reviewer', assurancePrivateKey, receiptBinding);

    const outside = await makeRoot();
    await writeFile(path.join(outside, 'pointer.txt'), 'outside');
    await expectCode(runPromotion(f, {
      async afterRootWrite(logicalPath) {
        if (logicalPath === 'index.html.artifact.json') {
          await symlink(outside, path.join(f.root, 'assets'));
        }
      },
    }), 'FOLDY_PATH_ESCAPE');
    expect(await readFile(path.join(outside, 'pointer.txt'), 'utf8')).toBe('outside');
    for (const logicalPath of rootFiles) expect(await readFile(path.join(f.root, logicalPath))).toEqual(f.priorRoot[logicalPath]);
  });

  it('returns explicit FOLDY_ROLLBACK_FAILED with details when rollback fails', async () => {
    const f = await fixture();
    const error = runPromotion(f, {
      afterRootWrite(logicalPath) {
        if (logicalPath === 'index.html') throw new Error('injected commit failure');
      },
      beforeRollbackRestore() {
        throw new Error('injected rollback failure');
      },
    });
    await expect(error).rejects.toMatchObject({
      code: 'FOLDY_ROLLBACK_FAILED',
      details: {
        rollbackErrors: expect.arrayContaining([expect.stringContaining('injected rollback failure')]),
        originalError: 'injected commit failure',
      },
    });
  });

  it('still blocks generic pointer mutation and exposes stable typed failures', async () => {
    const f = await fixture();
    await expectCode(assertGenericFoldyFileMutationAllowed({
      projectRoot: f.root,
      metadata: f.metadata,
      logicalPath: 'workbook.json',
      operation: 'write',
    }), 'FOLDY_PROMOTION_REQUIRED');
    expect(new FoldyPromotionError(409, 'FOLDY_STALE_CURRENT', 'stale')).toMatchObject({
      status: 409,
      code: 'FOLDY_STALE_CURRENT',
    });
  });
});

describe('safe legacy Foldy baseline enrollment', () => {
  async function legacyFixture() {
    const root = await makeRoot();
    const workbook = Buffer.from(JSON.stringify({ schemaVersion: '1.0', workbookId: 'workbook_alpha' }));
    const html = Buffer.from('<main>legacy baseline</main>');
    const artifact = Buffer.from(JSON.stringify({ metadata: { revisionId: currentRevisionId } }));
    await writeFile(path.join(root, 'workbook.json'), workbook);
    await writeFile(path.join(root, entryFile), html);
    await writeFile(path.join(root, `${entryFile}.artifact.json`), artifact);
    await mkdir(path.join(root, 'revisions', candidateRevisionId), { recursive: true });
    await writeFile(path.join(root, 'revisions', candidateRevisionId, 'sentinel.txt'), 'candidate-untouched');
    const metadata: FoldyProjectMetadata = {
      foldy: true,
      workbookId: 'workbook_alpha',
      revisionId: currentRevisionId,
      entryFile,
      kind: 'prototype',
    };
    const store = { current: structuredClone(metadata) };
    return { root, workbook, html, artifact, metadata, store };
  }

  const request = {
    version: 'foldy-legacy-baseline-enrollment.v1',
    expectedCurrentRevisionId: currentRevisionId,
  } as const;

  it('enrolls a legacy draft-preview whose authoritative revision and workbook live beside the entry file', async () => {
    const root = await makeRoot();
    const previewRevisionId = 'rev_preview_001';
    const previewDir = path.join(root, 'drafts', previewRevisionId);
    const previewEntry = `drafts/${previewRevisionId}/index.html`;
    const previewWorkbookPath = `drafts/${previewRevisionId}/workbook.json`;
    const workbook = Buffer.from(JSON.stringify({
      schemaVersion: '1.0',
      workbookId: 'workbook_alpha',
      revisions: [{ revisionId: previewRevisionId, state: 'DRAFT' }],
    }));
    const html = Buffer.from('<main>legacy draft preview</main>');
    const artifact = Buffer.from(JSON.stringify({ metadata: { revisionId: previewRevisionId } }));
    await mkdir(previewDir, { recursive: true });
    await writeFile(path.join(root, previewWorkbookPath), workbook);
    await writeFile(path.join(root, previewEntry), html);
    await writeFile(path.join(root, `${previewEntry}.artifact.json`), artifact);
    const metadata: FoldyProjectMetadata = {
      kind: 'foldy-draft-preview',
      candidateRevisionId: previewRevisionId,
      entryFile: previewEntry,
    };
    const store = { current: structuredClone(metadata) };

    const result = await enrollLegacyFoldyBaseline({
      projectId,
      projectRoot: root,
      request: {
        version: 'foldy-legacy-baseline-enrollment.v1',
        expectedCurrentRevisionId: previewRevisionId,
      },
      readProjectMetadata: () => structuredClone(store.current),
      compareAndSetProjectMetadata: (expected, replacement) => {
        if (!sameMetadata(store.current, expected)) return false;
        store.current = structuredClone(replacement);
        return true;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      currentRevisionId: previewRevisionId,
      workbookId: 'workbook_alpha',
      sourceWorkbookPath: previewWorkbookPath,
      rootPointerParityVerified: true,
      candidateTouched: false,
    });
    expect(await readFile(path.join(root, previewWorkbookPath))).toEqual(workbook);
    expect(await readFile(path.join(root, previewEntry))).toEqual(html);
    expect(await readFile(path.join(root, `${previewEntry}.artifact.json`))).toEqual(artifact);
    await expect(readFile(path.join(root, 'workbook.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const baselineRoot = path.join(root, 'revisions', previewRevisionId);
    const baselineWorkbook = JSON.parse(await readFile(path.join(baselineRoot, 'workbook.json'), 'utf8'));
    expect(baselineWorkbook.revisions.at(-1)).toMatchObject({
      revisionId: previewRevisionId,
      state: 'FROZEN',
      bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      protectedSurfaces: [expect.objectContaining({ path: '.foldy-baseline-control.json' })],
    });
    expect(store.current).toMatchObject({
      foldy: true,
      workbookId: 'workbook_alpha',
      revisionId: previewRevisionId,
      currentRevisionId: previewRevisionId,
      entryFile: previewEntry,
    });
  });

  it('rejects candidateRevisionId fallback outside the legacy draft-preview envelope', async () => {
    const f = await legacyFixture();
    delete f.store.current.revisionId;
    f.store.current.candidateRevisionId = currentRevisionId;
    f.store.current.kind = 'prototype';
    await expectCode(enrollLegacyFoldyBaseline({
      projectId,
      projectRoot: f.root,
      request,
      readProjectMetadata: () => structuredClone(f.store.current),
      compareAndSetProjectMetadata: () => true,
    }), 'FOLDY_STALE_CURRENT');
  });

  it('snapshots the current legacy root without changing root bytes or candidate content', async () => {
    const f = await legacyFixture();
    const result = await enrollLegacyFoldyBaseline({
      projectId,
      projectRoot: f.root,
      request,
      readProjectMetadata: () => structuredClone(f.store.current),
      compareAndSetProjectMetadata: (expected, replacement) => {
        if (!sameMetadata(f.store.current, expected)) return false;
        f.store.current = structuredClone(replacement);
        return true;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      projectId,
      currentRevisionId,
      workbookId: 'workbook_alpha',
      rootPointerParityVerified: true,
      protectedSurfacesEnrolled: 1,
      candidateTouched: false,
    });
    expect(await readFile(path.join(f.root, 'workbook.json'))).toEqual(f.workbook);
    expect(await readFile(path.join(f.root, entryFile))).toEqual(f.html);
    expect(await readFile(path.join(f.root, `${entryFile}.artifact.json`))).toEqual(f.artifact);
    expect(await readFile(path.join(f.root, 'revisions', candidateRevisionId, 'sentinel.txt'), 'utf8')).toBe('candidate-untouched');

    const baselineRoot = path.join(f.root, 'revisions', currentRevisionId);
    expect(await readFile(path.join(baselineRoot, entryFile))).toEqual(f.html);
    expect(await readFile(path.join(baselineRoot, `${entryFile}.artifact.json`))).toEqual(f.artifact);
    const baselineWorkbook = JSON.parse(await readFile(path.join(baselineRoot, 'workbook.json'), 'utf8'));
    expect(baselineWorkbook.revisions).toEqual([expect.objectContaining({
      revisionId: currentRevisionId,
      state: 'FROZEN',
      bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      protectedSurfaces: [expect.objectContaining({
        path: '.foldy-baseline-control.json',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    })]);
    expect(hashBundle(await filesAt(baselineRoot, rootFiles))).toBe(baselineWorkbook.revisions[0].bundleSha256);
    const controlBytes = await readFile(path.join(f.root, '.foldy-baseline-control.json'));
    expect(sha256(controlBytes)).toBe(baselineWorkbook.revisions[0].protectedSurfaces[0].sha256);
    expect(JSON.parse(controlBytes.toString('utf8'))).toEqual({
      version: 'foldy-legacy-baseline-control.v1',
      projectId,
      workbookId: 'workbook_alpha',
      revisionId: currentRevisionId,
      entryFile,
      rootFiles: [
        { path: 'index.html', sha256: sha256(f.html) },
        { path: 'index.html.artifact.json', sha256: sha256(f.artifact) },
        { path: 'workbook.json', sha256: sha256(f.workbook) },
      ],
    });
    expect(f.store.current).toEqual({
      ...f.metadata,
      foldy: true,
      workbookId: 'workbook_alpha',
      revisionId: currentRevisionId,
      currentRevisionId,
      entryFile,
      publicationFiles: ['workbook.json', 'index.html', 'index.html.artifact.json'],
    });
  });

  it('enrolls legacy workbooks with historical DRAFT revision records without rewriting history', async () => {
    const f = await legacyFixture();
    const historicalRevisions = [
      {
        revisionId: 'rev_legacy_001',
        state: 'DRAFT',
        title: 'Initial exploration',
      },
      {
        revisionId: currentRevisionId,
        parentRevisionId: 'rev_legacy_001',
        state: 'DRAFT',
        protectedSurfaces: [],
        note: 'Historical note must survive',
      },
    ];
    const historicalWorkbook = {
      schemaVersion: '1.0',
      workbookId: 'workbook_alpha',
      client: { name: 'Matt Brower' },
      customBusinessField: { retained: true },
      revisions: historicalRevisions,
    };
    const historicalBytes = Buffer.from(JSON.stringify(historicalWorkbook));
    await writeFile(path.join(f.root, 'workbook.json'), historicalBytes);
    await mkdir(path.join(f.root, 'revisions', 'rev_legacy_001'), { recursive: true });
    await writeFile(path.join(f.root, 'revisions', 'rev_legacy_001', 'sentinel.txt'), 'historical-untouched');

    const result = await enrollLegacyFoldyBaseline({
      projectId,
      projectRoot: f.root,
      request,
      readProjectMetadata: () => structuredClone(f.store.current),
      compareAndSetProjectMetadata: (expected, replacement) => {
        if (!sameMetadata(f.store.current, expected)) return false;
        f.store.current = structuredClone(replacement);
        return true;
      },
    });

    expect(result).toMatchObject({ ok: true, currentRevisionId, candidateTouched: false });
    expect(await readFile(path.join(f.root, 'workbook.json'))).toEqual(historicalBytes);
    expect(await readFile(path.join(f.root, 'revisions', 'rev_legacy_001', 'sentinel.txt'), 'utf8'))
      .toBe('historical-untouched');
    const baselineRoot = path.join(f.root, 'revisions', currentRevisionId);
    const baselineWorkbook = JSON.parse(await readFile(path.join(baselineRoot, 'workbook.json'), 'utf8'));
    expect(baselineWorkbook.revisions[0]).toEqual(historicalRevisions[0]);
    expect(baselineWorkbook.revisions).toHaveLength(2);
    expect(baselineWorkbook.revisions.at(-1)).toMatchObject({
      revisionId: currentRevisionId,
      parentRevisionId: 'rev_legacy_001',
      note: 'Historical note must survive',
      state: 'FROZEN',
      bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      protectedSurfaces: [{
        path: '.foldy-baseline-control.json',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    expect(hashBundle(await filesAt(baselineRoot, rootFiles)))
      .toBe(baselineWorkbook.revisions.at(-1).bundleSha256);
  });

  it('requires exact request keys and is one-shot', async () => {
    expect(() => parseFoldyLegacyBaselineEnrollmentRequest(projectId, { ...request, candidateRevisionId })).toThrowError(
      expect.objectContaining({ code: 'FOLDY_INVALID_REQUEST' }),
    );
    expect(() => parseFoldyLegacyBaselineEnrollmentRequest(projectId, { version: request.version })).toThrowError(
      expect.objectContaining({ code: 'FOLDY_INVALID_REQUEST' }),
    );
    const f = await legacyFixture();
    const options = {
      projectId,
      projectRoot: f.root,
      request,
      readProjectMetadata: () => structuredClone(f.store.current),
      compareAndSetProjectMetadata: (expected: FoldyProjectMetadata, replacement: FoldyProjectMetadata) => {
        if (!sameMetadata(f.store.current, expected)) return false;
        f.store.current = structuredClone(replacement);
        return true;
      },
    };
    await enrollLegacyFoldyBaseline(options);
    await expectCode(enrollLegacyFoldyBaseline(options), 'FOLDY_LEGACY_BASELINE_ALREADY_ENROLLED');
  });

  it('rolls back filesystem enrollment when metadata CAS loses', async () => {
    const f = await legacyFixture();
    await expectCode(enrollLegacyFoldyBaseline({
      projectId,
      projectRoot: f.root,
      request,
      readProjectMetadata: () => structuredClone(f.store.current),
      compareAndSetProjectMetadata: () => false,
    }), 'FOLDY_METADATA_CAS_FAILED');
    await expect(readFile(path.join(f.root, '.foldy-baseline-control.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(f.root, 'revisions', currentRevisionId, 'workbook.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(f.root, 'workbook.json'))).toEqual(f.workbook);
    expect(f.store.current).toEqual(f.metadata);
  });

  it('wires the one-shot route and returns typed exact-key validation failures', async () => {
    const f = await legacyFixture();
    const invalid = await invokeLegacyEnrollmentRoute({ root: f.root, metadata: f.metadata, body: { ...request, extra: true } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('FOLDY_INVALID_REQUEST');

    const enrolled = await invokeLegacyEnrollmentRoute({ root: f.root, metadata: f.metadata, body: request });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body).toMatchObject({ ok: true, currentRevisionId, candidateTouched: false });
    expect(enrolled.metadata).toMatchObject({ foldy: true, currentRevisionId });
  });
});

describe('no-protected-ancestor Foldy repair', () => {
  async function repairFixture() {
    const root = await makeRoot();
    const revisions = [currentRevisionId, candidateRevisionId];
    const workbook = {
      schemaVersion: '1.0', workbookId: 'workbook_alpha',
      revisions: revisions.map((revisionId, index) => ({
        revisionId, parentRevisionId: index ? revisions[index - 1] : undefined,
        state: 'FROZEN', bundleSha256: '1'.repeat(64), protectedSurfaces: [],
      })),
    };
    await writeFile(path.join(root, 'workbook.json'), JSON.stringify(workbook));
    await writeFile(path.join(root, entryFile), '<main>current design</main>');
    await writeFile(path.join(root, `${entryFile}.artifact.json`), JSON.stringify({ metadata: { revisionId: candidateRevisionId } }));
    for (const revisionId of revisions) {
      const revisionRoot = path.join(root, 'revisions', revisionId);
      await mkdir(revisionRoot, { recursive: true });
      await writeFile(path.join(revisionRoot, 'workbook.json'), JSON.stringify(workbook));
      await writeFile(path.join(revisionRoot, entryFile), `<main>${revisionId}</main>`);
      await writeFile(path.join(revisionRoot, `${entryFile}.artifact.json`), JSON.stringify({ revisionId }));
    }
    const metadata: FoldyProjectMetadata = {
      foldy: true, workbookId: 'workbook_alpha', revisionId: candidateRevisionId,
      currentRevisionId: candidateRevisionId, entryFile,
    };
    const store = { current: structuredClone(metadata) };
    const request = {
      version: 'foldy-no-protected-ancestor-repair.v1',
      expectedCurrentRevisionId: candidateRevisionId,
      repairRevisionId: 'rev_000003',
      dedupKey: 'foldy-legacy-no-protected-ancestor-repair-20260829',
    } as const;
    const options = {
      projectId, projectRoot: root, request,
      readProjectMetadata: () => structuredClone(store.current),
      compareAndSetProjectMetadata: (expected: FoldyProjectMetadata, replacement: FoldyProjectMetadata) => {
        if (!sameMetadata(store.current, expected)) return false;
        store.current = structuredClone(replacement);
        return true;
      },
    };
    return { root, revisions, workbook, metadata, store, request, options };
  }

  it('creates a new protected baseline while preserving prior revisions and root parity', async () => {
    const f = await repairFixture();
    const before = new Map<string, string>();
    for (const revisionId of f.revisions) {
      for (const logicalPath of rootFiles) before.set(`${revisionId}/${logicalPath}`, sha256(await readFile(path.join(f.root, 'revisions', revisionId, logicalPath))));
    }
    const result = await repairFoldyNoProtectedAncestor(f.options);
    expect(result).toMatchObject({
      ok: true, idempotent: false, priorRevisionId: candidateRevisionId,
      currentRevisionId: 'rev_000003', protectedSurfacesEnrolled: 1,
      rootPointerParityVerified: true, candidateTouched: false,
      protectedManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const [key, digest] of before) expect(sha256(await readFile(path.join(f.root, 'revisions', key)))).toBe(digest);
    for (const logicalPath of rootFiles) {
      expect(await readFile(path.join(f.root, logicalPath))).toEqual(await readFile(path.join(f.root, 'revisions', 'rev_000003', logicalPath)));
    }
    const repaired = JSON.parse(await readFile(path.join(f.root, 'workbook.json'), 'utf8'));
    expect(repaired.revisions.at(-1)).toMatchObject({
      revisionId: 'rev_000003', parentRevisionId: candidateRevisionId, state: 'FROZEN',
      protectedSurfaces: [{ path: '.foldy-protected-surface-control.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    });
    expect(f.store.current).toMatchObject({ revisionId: 'rev_000003', currentRevisionId: 'rev_000003' });
  });

  it('repairs a legacy established lineage whose envelope has revisionId but no currentRevisionId', async () => {
    const f = await repairFixture();
    delete f.store.current.currentRevisionId;
    await expect(repairFoldyNoProtectedAncestor(f.options)).resolves.toMatchObject({
      ok: true,
      idempotent: false,
      priorRevisionId: candidateRevisionId,
      currentRevisionId: 'rev_000003',
      rootPointerParityVerified: true,
    });
    expect(f.store.current).toMatchObject({ revisionId: 'rev_000003', currentRevisionId: 'rev_000003' });
  });

  it('is idempotent only for the exact dedup-bound replay', async () => {
    const f = await repairFixture();
    await repairFoldyNoProtectedAncestor(f.options);
    await expect(repairFoldyNoProtectedAncestor(f.options)).resolves.toMatchObject({ ok: true, idempotent: true });
    const different = { ...f.options, request: { ...f.request, dedupKey: 'different-repair' } };
    await expectCode(repairFoldyNoProtectedAncestor(different), 'FOLDY_BASELINE_REPAIR_ALREADY_APPLIED');
  });

  it('rolls back the revision, control, and root workbook when metadata CAS loses', async () => {
    const f = await repairFixture();
    const priorWorkbook = await readFile(path.join(f.root, 'workbook.json'));
    await expectCode(repairFoldyNoProtectedAncestor({ ...f.options, compareAndSetProjectMetadata: () => false }), 'FOLDY_METADATA_CAS_FAILED');
    expect(await readFile(path.join(f.root, 'workbook.json'))).toEqual(priorWorkbook);
    await expect(readFile(path.join(f.root, 'revisions', 'rev_000003', 'workbook.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(f.root, '.foldy-protected-surface-control.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.store.current).toEqual(f.metadata);
  });

  it('rejects a lineage that already has a protected ancestor and exact-key violations', async () => {
    const f = await repairFixture();
    expect(() => parseFoldyNoProtectedAncestorRepairRequest(projectId, { ...f.request, extra: true })).toThrowError(
      expect.objectContaining({ code: 'FOLDY_INVALID_REQUEST' }),
    );
    const workbookPath = path.join(f.root, 'workbook.json');
    const workbook = JSON.parse(await readFile(workbookPath, 'utf8'));
    workbook.revisions[0].protectedSurfaces = [{ path: 'brand.css', sha256: '0'.repeat(64) }];
    await writeFile(workbookPath, JSON.stringify(workbook));
    await expectCode(repairFoldyNoProtectedAncestor(f.options), 'FOLDY_PROTECTED_ANCESTOR_EXISTS');
  });
});
