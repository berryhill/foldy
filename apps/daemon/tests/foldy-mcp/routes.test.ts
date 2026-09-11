import type http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFoldyMcpGrantStore } from '../../src/foldy-mcp/grants.js';
import { registerFoldyMcpRoutes } from '../../src/routes/foldy-mcp.js';

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
    deploy: vi.fn(async (projectId, input) => ({ projectId, input })),
  } });
  const server = await new Promise<http.Server>((resolve) => { const started = app.listen(0, () => resolve(started)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind failed');
  cleanup.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const request = (url: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${url}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  return { request, grants, publicationStore, setDaemonUrl: (value: string) => { daemonUrl = value; } };
}

describe('Foldy MCP daemon routes', () => {
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
      actorId: 'mcp:g-1',
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
