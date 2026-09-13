import type http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFoldyMcpGrantStore } from '../../src/foldy-mcp/grants.js';
import { CynderDeploymentError } from '../../src/foldy-deployments/cynder.js';
import { createFoldyMcpRevocationService, registerFoldyMcpRoutes } from '../../src/routes/foldy-mcp.js';
import { FoldyPublicationStore } from '../../src/foldy-publications/store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foldy-mcp-routes-'));
  const grants = await createFoldyMcpGrantStore({ dataRoot: root, randomToken: () => 'route-secret', randomId: () => 'g-1' });
  const publicationStore = {
    getState: vi.fn(async (projectId: string) => ({ projectId })),
    getRevision: vi.fn(async (projectId: string, revisionId: string) => ({ projectId, revisionId })),
    saveRevision: vi.fn(async (input: unknown) => input),
    requestReview: vi.fn(async (input: unknown) => input),
    addReviewComment: vi.fn(async (input: unknown) => input),
    decideReview: vi.fn(async (input: unknown) => input),
    publish: vi.fn(async (input: unknown) => input),
    rollback: vi.fn(async (input: unknown) => input),
  };
  const deploy = vi.fn(async (projectId: string, input: unknown) => ({ projectId, input }));
  const revokeMcpGrant = vi.fn(async (_input: { grantId: string; tokenSha256: string; projectId: string }) => undefined);
  const revocations = createFoldyMcpRevocationService({ grants, revokeMcpGrant, timeoutMs: 50, maxIntents: 10 });
  const app = express(); app.use(express.json());
  let daemonUrl = 'http://127.0.0.1:7456';
  registerFoldyMcpRoutes(app, { foldyMcp: {
    grants,
    command: 'od', getDaemonUrl: () => daemonUrl,
    isLocalAuthority: (req) => req.get('x-local-authority') === 'yes',
    resolveProject: (id) => id === 'project-a' || id === 'project-b' ? {
      id,
      metadata: {
        foldy: true,
        entryFile: 'index.html',
        publicationFiles: ['assets/app.css', 'index.html'],
      },
    } : null,
    resolveProjectRoot: (project) => `/projects/${project.id}`,
    publicationStore,
    deploy,
    revocations,
  } });
  const server = await new Promise<http.Server>((resolve) => { const started = app.listen(0, () => resolve(started)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind failed');
  cleanup.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const request = (url: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${url}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  return { request, grants, publicationStore, deploy, revokeMcpGrant, setDaemonUrl: (value: string) => { daemonUrl = value; } };
}

async function realPublicationFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foldy-mcp-real-store-'));
  const projectRoot = path.join(root, 'projects', 'project-a');
  await mkdir(path.join(projectRoot, 'assets'), { recursive: true });
  await writeFile(path.join(projectRoot, 'index.html'), '<h1>exact MCP revision</h1>');
  await writeFile(path.join(projectRoot, 'assets', 'app.css'), 'body { color: rebeccapurple; }');

  const grants = await createFoldyMcpGrantStore({
    dataRoot: path.join(root, 'grants'),
    randomId: () => 'real-store-grant',
  });
  let nextPublicationId = 0;
  const publicationStore = new FoldyPublicationStore({
    rootDir: path.join(root, 'publications'),
    randomId: () => `publication-${++nextPublicationId}`,
  });
  const revocations = createFoldyMcpRevocationService({
    grants,
    revokeMcpGrant: async () => undefined,
  });
  const app = express();
  app.use(express.json());
  registerFoldyMcpRoutes(app, { foldyMcp: {
    grants,
    command: 'od',
    getDaemonUrl: () => 'http://127.0.0.1:7456',
    isLocalAuthority: () => true,
    resolveProject: (id) => id === 'project-a' || id === 'project-b' ? {
      id,
      metadata: {
        foldy: true,
        entryFile: 'index.html',
        publicationFiles: ['assets/app.css', 'index.html'],
      },
    } : null,
    resolveProjectRoot: (project) => path.join(root, 'projects', project.id),
    publicationStore,
    deploy: async () => ({}),
    revocations,
  } });
  const server = await new Promise<http.Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind failed');
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const request = (operation: string, input: Record<string, unknown>, token: string) => fetch(
    `http://127.0.0.1:${address.port}/api/foldy/mcp/operations/${operation}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    },
  );
  return { request, grants, publicationStore };
}

describe('Foldy MCP daemon routes', () => {
  it('runs the exact-revision review workflow against the real publication store with grant-scoped audit identity', async () => {
    const f = await realPublicationFixture();
    const issued = await f.grants.create({ projectId: 'project-a', scopes: ['editor', 'reviewer'] });
    const actorId = `mcp-${issued.grant.grantId}`;

    const savedResponse = await f.request('foldy_save_revision', {
      entryFile: 'index.html',
      expectedLatestRevisionId: null,
    }, issued.token);
    expect(savedResponse.status).toBe(200);
    const revision = await savedResponse.json() as any;
    expect(revision).toMatchObject({
      entryFile: 'index.html',
      createdBy: actorId,
      fileCount: 2,
    });
    expect(revision.files.map((file: { path: string }) => file.path)).toEqual(['assets/app.css', 'index.html']);

    const requestedResponse = await f.request('foldy_request_review', {
      revisionId: revision.revisionId,
      expectedLatestRevisionId: revision.revisionId,
    }, issued.token);
    expect(requestedResponse.status).toBe(200);
    const requested = await requestedResponse.json() as any;
    expect(requested).toMatchObject({
      revisionId: revision.revisionId,
      status: 'requested',
      version: 1,
      requestedBy: actorId,
    });

    const commentResponse = await f.request('foldy_add_review_comment', {
      revisionId: revision.revisionId,
      reviewId: requested.reviewId,
      body: 'Exact revision reviewed through MCP.',
      expectedReviewVersion: requested.version,
    }, issued.token);
    expect(commentResponse.status).toBe(200);
    const comment = await commentResponse.json() as any;
    expect(comment).toMatchObject({
      reviewId: requested.reviewId,
      revisionId: revision.revisionId,
      body: 'Exact revision reviewed through MCP.',
      createdBy: actorId,
    });

    const decidedResponse = await f.request('foldy_decide_review', {
      revisionId: revision.revisionId,
      reviewId: requested.reviewId,
      decision: 'approved',
      expectedReviewVersion: 2,
    }, issued.token);
    expect(decidedResponse.status).toBe(200);
    const decided = await decidedResponse.json() as any;
    expect(decided).toMatchObject({
      reviewId: requested.reviewId,
      revisionId: revision.revisionId,
      status: 'approved',
      version: 3,
      requestedBy: actorId,
      decidedBy: actorId,
      comments: [{ createdBy: actorId }],
    });

    const projectState = await f.publicationStore.getState('project-a');
    expect(projectState).toMatchObject({ latestRevisionId: revision.revisionId, activeReview: null });
    expect(projectState.reviews).toContainEqual(decided);
    expect((await f.publicationStore.getState('project-b')).latestRevisionId).toBeNull();
  });

  it('rejects MCP publication without an approved review for that exact revision', async () => {
    const f = await fixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'foldy-mcp-exact-review-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const projectRoot = path.join(root, 'project');
    await mkdir(path.join(projectRoot, 'assets'), { recursive: true });
    await writeFile(path.join(projectRoot, 'index.html'), '<h1>exact</h1>');
    await writeFile(path.join(projectRoot, 'assets', 'app.css'), 'body{}');
    const store = new FoldyPublicationStore({ rootDir: path.join(root, 'store'), randomId: () => 'revision-unreviewed' });
    const revision = await store.saveRevision({ projectId: 'project-a', projectRoot, entryFile: 'index.html', publicationFiles: ['index.html', 'assets/app.css'], expectedLatestRevisionId: null, actorId: 'setup' });
    f.publicationStore.publish.mockImplementation((input: any) => store.publish(input));
    await f.grants.create({ projectId: 'project-a', scopes: ['publisher'] });

    const response = await f.request('/api/foldy/mcp/operations/foldy_publish', {
      method: 'POST', headers: { authorization: 'Bearer route-secret' },
      body: JSON.stringify({ revisionId: revision.revisionId, expectedPublishedGeneration: 0 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'FOLDY_APPROVAL_REQUIRED' } });
    expect((await store.getState('project-a')).publishedRevisionId).toBeNull();
  });

  it('durably denies locally before provider revocation and never exposes the digest', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read', 'deployer'] });
    f.revokeMcpGrant.mockImplementationOnce(async (descriptor) => {
      expect(f.grants.authenticate('route-secret', 'project-a', 'read')).toBeNull();
      expect(f.grants.deploymentDescriptor(descriptor.grantId, 'project-b')).toBeNull();
    });

    const response = await f.request('/api/foldy/mcp/grants/g-1', {
      method: 'DELETE', headers: { 'x-local-authority': 'yes' }, body: JSON.stringify({ projectId: 'project-b' }),
    });

    expect(response.status).toBe(200);
    expect(f.revokeMcpGrant).toHaveBeenCalledWith({
      grantId: 'g-1', projectId: 'project-a', tokenSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(f.grants.authenticate('route-secret', 'project-a', 'read')).toBeNull();
    expect(await response.text()).not.toContain('tokenSha256');
  });

  it('returns accepted pending after provider failure, denies locally, and succeeds on repeated DELETE', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read'] });
    f.revokeMcpGrant.mockRejectedValueOnce(new CynderDeploymentError(502, 'RAW_PROVIDER_CODE', 'sensitive provider detail'));

    const failed = await f.request('/api/foldy/mcp/grants/g-1', { method: 'DELETE', headers: { 'x-local-authority': 'yes' } });
    expect(failed.status).toBe(202);
    const failedText = await failed.text();
    expect(JSON.parse(failedText)).toMatchObject({ grant: { revocationStatus: 'pending' } });
    expect(failedText).not.toMatch(/tokenSha256|route-secret|[a-f0-9]{64}/);
    expect(f.grants.authenticate('route-secret', 'project-a', 'read')).toBeNull();

    const retried = await f.request('/api/foldy/mcp/grants/g-1', { method: 'DELETE', headers: { 'x-local-authority': 'yes' } });
    expect(retried.status).toBe(200);
    expect(f.revokeMcpGrant).toHaveBeenCalledTimes(2);
    expect(f.grants.authenticate('route-secret', 'project-a', 'read')).toBeNull();
    expect((await f.request('/api/foldy/mcp/grants/g-1', { method: 'DELETE', headers: { 'x-local-authority': 'yes' } })).status).toBe(200);
    expect(f.revokeMcpGrant).toHaveBeenCalledTimes(2);
  });

  it('returns accepted pending and keeps local denial when provider revoke times out', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read'] });
    f.revokeMcpGrant.mockRejectedValueOnce(new CynderDeploymentError(504, 'FOLDY_CYNDER_PROVIDER_TIMEOUT', 'Cynder provider request timed out'));

    const response = await f.request('/api/foldy/mcp/grants/g-1', { method: 'DELETE', headers: { 'x-local-authority': 'yes' } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ grant: { revocationStatus: 'pending' } });
    expect(f.grants.authenticate('route-secret', 'project-a', 'read')).toBeNull();
  });

  it('reconciles pending intents through the authenticated local-only operator route', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read'] });
    f.revokeMcpGrant.mockRejectedValueOnce(new Error('provider offline'));
    await f.request('/api/foldy/mcp/grants/g-1', { method: 'DELETE', headers: { 'x-local-authority': 'yes' } });
    expect((await f.request('/api/foldy/mcp/revocations/reconcile', { method: 'POST' })).status).toBe(403);
    const reconciled = await f.request('/api/foldy/mcp/revocations/reconcile', { method: 'POST', headers: { 'x-local-authority': 'yes' } });
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toEqual({ attempted: 1, completed: 1, pending: 0 });
    expect(f.revokeMcpGrant).toHaveBeenCalledTimes(2);
    const repeated = await f.request('/api/foldy/mcp/revocations/reconcile', { method: 'POST', headers: { 'x-local-authority': 'yes' } });
    expect(await repeated.json()).toEqual({ attempted: 0, completed: 0, pending: 0 });
    expect(f.revokeMcpGrant).toHaveBeenCalledTimes(2);
  });

  it('protects grant administration with local authority, returns token once, and never lists it', async () => {
    const f = await fixture();
    expect((await f.request('/api/foldy/mcp/grants', { method: 'POST', body: JSON.stringify({ projectId: 'project-a', scopes: ['read'] }) })).status).toBe(403);
    const created = await f.request('/api/foldy/mcp/grants', { method: 'POST', headers: { 'x-local-authority': 'yes' }, body: JSON.stringify({ projectId: 'project-a', scopes: ['read'] }) });
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.token).toBe('route-secret');
    expect(body.installInfo.clients.generic).toBeTruthy();
    const listed = await f.request('/api/foldy/mcp/grants', { headers: { 'x-local-authority': 'yes' } });
    const listedText = await listed.text();
    expect(listedText).not.toContain('route-secret');
    expect(listedText).not.toContain('tokenSha256');
  });

  it('uses only bearer grants, fixes project server-side, rejects cross-project hints, and denies after revoke', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read'] });
    const cookieOnly = await f.request('/api/foldy/mcp/session', { headers: { cookie: 'foldy_browser_session=anything' } });
    expect(cookieOnly.status).toBe(401);
    const auth = { authorization: 'Bearer route-secret' };
    expect((await f.request('/api/foldy/mcp/session', { headers: auth })).status).toBe(200);
    const operation = await f.request('/api/foldy/mcp/operations/foldy_get_publication', { method: 'POST', headers: auth, body: JSON.stringify({ projectId: 'project-b' }) });
    expect(operation.status).toBe(400);
    expect(f.publicationStore.getState).not.toHaveBeenCalled();
    await f.grants.revoke('g-1');
    expect((await f.request('/api/foldy/mcp/session', { headers: auth })).status).toBe(401);
  });

  it('enforces independent operation scopes', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['reviewer'] });
    const auth = { authorization: 'Bearer route-secret' };
    expect((await f.request('/api/foldy/mcp/operations/foldy_save_revision', { method: 'POST', headers: auth, body: '{}' })).status).toBe(403);
    expect((await f.request('/api/foldy/mcp/operations/foldy_request_review', { method: 'POST', headers: auth, body: JSON.stringify({ revisionId: 'r', expectedLatestRevisionId: 'r' }) })).status).toBe(200);
  });

  it('derives public access and the active project-bound MCP descriptor for MCP deployments', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read', 'deployer'] });
    const response = await f.request('/api/foldy/mcp/operations/foldy_deploy', {
      method: 'POST',
      headers: { authorization: 'Bearer route-secret' },
      body: JSON.stringify({ revisionId: 'r', environment: 'prod', idempotencyKey: 'k', expectedActiveProviderRevisionId: null }),
    });

    expect(response.status).toBe(200);
    expect(f.deploy).toHaveBeenCalledWith('project-a', {
      revisionId: 'r', environment: 'prod', idempotencyKey: 'k', expectedActiveProviderRevisionId: null,
      accessPolicy: { mode: 'public' },
      mcpGrant: {
        grantId: 'g-1',
        scopes: ['read', 'deployer'],
        tokenSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(f.deploy.mock.calls[0])).not.toContain('route-secret');
  });

  it('uses the enrolled entry and exact publication file list when saving a revision', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['editor'] });
    const response = await f.request('/api/foldy/mcp/operations/foldy_save_revision', {
      method: 'POST',
      headers: { authorization: 'Bearer route-secret' },
      body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    });

    expect(response.status).toBe(200);
    expect(f.publicationStore.saveRevision).toHaveBeenCalledWith({
      projectId: 'project-a',
      projectRoot: '/projects/project-a',
      entryFile: 'index.html',
      publicationFiles: ['index.html', 'assets/app.css'],
      expectedLatestRevisionId: null,
      actorId: 'mcp-g-1',
    });
  });

  it('rejects MCP attempts to override the enrolled entry or publication files', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['editor'] });
    const auth = { authorization: 'Bearer route-secret' };

    const entryOverride = await f.request('/api/foldy/mcp/operations/foldy_save_revision', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ entryFile: 'other.html', expectedLatestRevisionId: null }),
    });
    expect(entryOverride.status).toBe(422);
    expect(await entryOverride.json()).toMatchObject({ error: { code: 'FOLDY_ENTRY_IDENTITY_MISMATCH' } });

    const filesOverride = await f.request('/api/foldy/mcp/operations/foldy_save_revision', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        entryFile: 'index.html',
        publicationFiles: ['private.txt'],
        expectedLatestRevisionId: null,
      }),
    });
    expect(filesOverride.status).toBe(400);
    expect(f.publicationStore.saveRevision).not.toHaveBeenCalled();
  });

  it('enforces the published schemas and rejects every project override at HTTP', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read', 'deployer'] });
    const auth = { authorization: 'Bearer route-secret' };
    const cases: Array<[string, unknown]> = [
      ['foldy_get_revision', {}],
      ['foldy_get_revision', { revisionId: 3 }],
      ['foldy_get_revision', { revisionId: 'r', extra: true }],
      ['foldy_get_publication', { project: 'project-b' }],
      ['foldy_get_publication', { project_id: 'project-b' }],
      ['foldy_get_publication', { projectId: 'project-b' }],
      ['foldy_deploy', { revisionId: 'r', environment: 'prod', idempotencyKey: 'k' }],
      ['foldy_deploy', { revisionId: 'r', environment: 'prod', idempotencyKey: 'k', expectedActiveProviderRevisionId: false }],
    ];
    for (const [operation, input] of cases) {
      const response = await f.request(`/api/foldy/mcp/operations/${operation}`, { method: 'POST', headers: auth, body: JSON.stringify(input) });
      expect(response.status, `${operation}: ${JSON.stringify(input)}`).toBe(400);
    }
    expect(f.publicationStore.getRevision).not.toHaveBeenCalled();
  });

  it('resolves the daemon URL when install info is requested, after dynamic bind changes', async () => {
    const f = await fixture();
    await f.grants.create({ projectId: 'project-a', scopes: ['read'] });
    f.setDaemonUrl('http://127.0.0.1:49123');
    const response = await f.request('/api/foldy/mcp/grants/g-1/install', { headers: { 'x-local-authority': 'yes' } });
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.clients.generic.env.OD_DAEMON_URL).toBe('http://127.0.0.1:49123');
  });
});
