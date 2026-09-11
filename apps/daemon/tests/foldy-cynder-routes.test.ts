import type http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFoldyCynderRoutes } from '../src/routes/foldy-cynder.js';
import type { FoldyMcpGrantStore } from '../src/foldy-mcp/grants.js';

const servers: http.Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))));
async function fixture(local = false, authorized = true) {
  const deploy = vi.fn(async (input) => ({ ...input, receiptId: 'receipt-1', status: 'active' }));
  const rollback = vi.fn(async (input) => ({ ...input, receiptId: 'receipt-2', status: 'active' }));
  const grants = { authenticate: vi.fn((_token, projectId, scope) => authorized && projectId === 'project-1' && scope === 'deployer' ? { grantId: 'grant-1', projectId, scopes: ['deployer'], createdAt: '', revokedAt: null } : null) } as unknown as FoldyMcpGrantStore;
  const app = express(); app.use(express.json());
  registerFoldyCynderRoutes(app, { foldyCynder: { deployments: { deploy, rollback } as any, grants, isLocalAuthority: () => local, isFormalProject: (id) => id === 'project-1' } });
  const server = await new Promise<http.Server>((resolve) => { const listening = app.listen(0, () => resolve(listening)); }); servers.push(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
  const request = (route: string, body: unknown, token?: string) => fetch(`http://127.0.0.1:${address.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { request, deploy, rollback };
}
const validBody = { environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: null };
describe('Foldy Cynder routes', () => {
  it('derives project and revision and authorizes a T004 deployer bearer', async () => {
    const f = await fixture(); const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', validBody, 'grant-token');
    expect(response.status).toBe(201); expect(f.deploy).toHaveBeenCalledWith({ projectId: 'project-1', revisionId: 'rev-1', ...validBody });
  });
  it('rejects caller-supplied project, revision, or bundle bindings', async () => {
    const f = await fixture(true); const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', { ...validBody, bundleSha256: 'attacker' });
    expect(response.status).toBe(400); expect((await response.json() as any).error.code).toBe('FOLDY_CYNDER_DERIVED_BINDING_REQUIRED'); expect(f.deploy).not.toHaveBeenCalled();
  });
  it('requires deployer bearer authorization unless the local admin boundary succeeds', async () => {
    const f = await fixture(false, false); const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/rollback', validBody, 'wrong');
    expect(response.status).toBe(403); expect(f.rollback).not.toHaveBeenCalled();
  });
});
