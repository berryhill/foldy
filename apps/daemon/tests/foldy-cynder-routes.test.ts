import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFoldyCynderRoutes } from '../src/routes/foldy-cynder.js';
import type { FoldyMcpGrantStore } from '../src/foldy-mcp/grants.js';

const servers: http.Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))));
async function fixture(local = false, authorized = true, withBinding = false, remoteAddress?: string) {
  const tokenSha256 = 'a'.repeat(64);
  const binding = withBinding ? {
    providerDeploymentId: 'deployment-1', providerRevisionId: 'provider-revision-1',
    projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'b'.repeat(64), environment: 'production',
    url: 'https://deploy.example/project-1', mcpUrl: 'https://deploy.example/project-1/mcp', accessMode: 'public',
  } : null;
  const deploy = vi.fn(async (input) => ({ ...input, receiptId: 'receipt-1', status: 'active', binding }));
  const rollback = vi.fn(async (input) => ({
    ...input,
    receiptId: 'receipt-2',
    status: 'active',
    binding,
    accessPolicy: { mode: 'public' as const },
    mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'] as const, tokenSha256 },
  }));
  const receipt = { schemaVersion: 1 as const, receiptId: 'receipt-status', kind: 'deploy' as const, status: 'staged' as const, projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'b'.repeat(64), environment: 'production', idempotencyKey: 'stored-key', accessPolicy: { mode: 'password_required' as const, passwordScryptVerifier: `scrypt$16384$8$1$${'c'.repeat(32)}$${'d'.repeat(64)}` }, mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'] as const, tokenSha256 }, expectedActiveProviderRevisionId: null, priorActive: null, binding, health: null, createdAt: '2026-09-10T00:00:00.000Z', completedAt: null };
  const getStatus = vi.fn(async () => ({ binding, completed: [], staged: [receipt] }));
  const recover = vi.fn(async () => ({ ...receipt, status: 'active', completedAt: '2026-09-10T01:00:00.000Z' }));
  const grants = {
    authenticate: vi.fn((_token, projectId, scope) => authorized && projectId === 'project-1' && scope === 'deployer' ? { grantId: 'grant-1', projectId, scopes: ['deployer'], createdAt: '', revokedAt: null } : null),
    deploymentDescriptor: vi.fn((grantId, projectId) => grantId === 'grant-1' && projectId === 'project-1'
      ? { grantId, scopes: ['read', 'deployer'], tokenSha256 }
      : null),
  } as unknown as FoldyMcpGrantStore;
  const app = express();
  if (remoteAddress) app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress }); next(); });
  app.use(express.json());
  registerFoldyCynderRoutes(app, { foldyCynder: { deployments: { deploy, rollback, getStatus, recover } as any, grants, isLocalAuthority: () => local, isFormalProject: (id) => id === 'project-1' } });
  const server = await new Promise<http.Server>((resolve) => { const listening = app.listen(0, () => resolve(listening)); }); servers.push(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
  const request = (route: string, body?: unknown, token?: string, method = 'POST') => fetch(`http://127.0.0.1:${address.port}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, deploy, rollback, getStatus, recover, grants, tokenSha256 };
}
const validBody = { environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: null, mcpGrantId: 'grant-1' };
describe('Foldy Cynder routes', () => {
  it('rejects a password over remote plaintext HTTP before derivation or deployment', async () => {
    const f = await fixture(true, true, false, '203.0.113.8');
    const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', { ...validBody, accessMode: 'password_required', password: randomUUID() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'FOLDY_CYNDER_INSECURE_PASSWORD_TRANSPORT' } });
    expect(f.deploy).not.toHaveBeenCalled();
  });

  it('parses rollback without password or MCP grant derivation', async () => {
    const f = await fixture(true);
    const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/rollback', {
      environment: 'production', idempotencyKey: 'rollback-only', expectedActiveProviderRevisionId: null,
    });
    expect(response.status).toBe(200);
    expect(f.rollback).toHaveBeenCalledWith({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'rollback-only', expectedActiveProviderRevisionId: null });
    expect(f.grants.deploymentDescriptor).not.toHaveBeenCalled();
  });
  it('returns authorized no-store durable status while redacting all custody descriptors', async () => {
    const f = await fixture(false, true, true);
    const response = await f.request('/api/projects/project-1/cynder/status?environment=production', undefined, 'grant-token', 'GET');
    const serialized = await response.text();
    const body = JSON.parse(serialized);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.getStatus).toHaveBeenCalledWith('project-1', 'production');
    expect(body.staged[0]).toMatchObject({ accessMode: 'password_required', mcpGrantId: 'grant-1' });
    expect(body).toHaveProperty('remoteMcpInstallInfo');
    expect(serialized).not.toContain(f.tokenSha256);
    expect(serialized).not.toContain('passwordScryptVerifier');
  });

  it('recovers by environment and optional receipt only and rejects replacement deployment fields', async () => {
    const f = await fixture(false, true);
    const response = await f.request('/api/projects/project-1/cynder/recover', { environment: 'production', receiptId: 'receipt-status' }, 'grant-token');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.recover).toHaveBeenCalledWith({ projectId: 'project-1', environment: 'production', receiptId: 'receipt-status' });
    const rejected = await f.request('/api/projects/project-1/cynder/recover', { environment: 'production', revisionId: 'replacement' }, 'grant-token');
    expect(rejected.status).toBe(400);
    expect((await rejected.json() as any).error.code).toBe('FOLDY_CYNDER_RECOVERY_DERIVED_REQUEST_REQUIRED');
    expect(f.recover).toHaveBeenCalledTimes(1);
  });

  it('derives project and revision and authorizes a T004 deployer bearer', async () => {
    const f = await fixture(); const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', validBody, 'grant-token');
    expect(response.status).toBe(201); expect(f.deploy).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: null,
      accessPolicy: { mode: 'public' },
      mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'], tokenSha256: 'a'.repeat(64) },
    }));
    expect(f.deploy.mock.calls[0]?.[0]).not.toHaveProperty('mcpGrantId');
  });
  it('rejects caller-supplied project, revision, or bundle bindings', async () => {
    const f = await fixture(true); const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', { ...validBody, bundleSha256: 'attacker' });
    expect(response.status).toBe(400); expect((await response.json() as any).error.code).toBe('FOLDY_CYNDER_DERIVED_BINDING_REQUIRED'); expect(f.deploy).not.toHaveBeenCalled();
  });
  it('requires deployer bearer authorization unless the local admin boundary succeeds', async () => {
    const f = await fixture(false, false); const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/rollback', validBody, 'wrong');
    expect(response.status).toBe(403); expect(f.rollback).not.toHaveBeenCalled();
  });
  it('defaults access to public and passes only the project-scoped grant descriptor', async () => {
    const f = await fixture(true);
    const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', validBody);
    expect(response.status).toBe(201);
    expect(f.deploy).toHaveBeenCalledWith(expect.objectContaining({
      accessPolicy: { mode: 'public' },
      mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'], tokenSha256: 'a'.repeat(64) },
    }));
  });
  it('derives a scrypt verifier for the provider but redacts that exact verifier and grant digest from the public receipt', async () => {
    const f = await fixture(true);
    const password = randomUUID();
    const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', { ...validBody, accessMode: 'password_required', password });
    const forwarded = f.deploy.mock.calls[0]?.[0] as any;
    const verifier = forwarded.accessPolicy.passwordScryptVerifier as string;
    const serialized = await response.text();
    expect(response.status).toBe(201);
    expect(forwarded.accessPolicy).toMatchObject({ mode: 'password_required', passwordScryptVerifier: expect.stringMatching(/^scrypt\$/) });
    expect(JSON.stringify(forwarded)).not.toContain(password);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(verifier);
    expect(serialized).not.toContain(f.tokenSha256);
    expect(JSON.parse(serialized)).toMatchObject({
      accessMode: 'password_required',
      mcpGrantId: 'grant-1',
      scopes: ['read', 'deployer'],
    });
    expect(JSON.parse(serialized)).not.toHaveProperty('accessPolicy');
    expect(JSON.parse(serialized)).not.toHaveProperty('mcpGrant');
  });
  it.each([
    [{ ...validBody, accessMode: 'password_required' }, 'FOLDY_CYNDER_PASSWORD_REQUIRED'],
    [{ ...validBody, accessMode: 'public', password: randomUUID() }, 'FOLDY_CYNDER_PASSWORD_NOT_ALLOWED'],
    [{ ...validBody, mcpGrantId: 'other-grant' }, 'FOLDY_CYNDER_MCP_GRANT_INVALID'],
  ])('rejects invalid access or grant provisioning', async (body, code) => {
    const f = await fixture(true);
    const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', body);
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe(code);
    expect(f.deploy).not.toHaveBeenCalled();
  });
  it.each([
    ['deploy', 201],
    ['rollback', 200],
  ] as const)('adds secret-free remote MCP instructions to a %s receipt with a binding', async (operation, expectedStatus) => {
    const f = await fixture(true, true, true);
    const requestBody = operation === 'deploy'
      ? validBody
      : { environment: validBody.environment, idempotencyKey: validBody.idempotencyKey, expectedActiveProviderRevisionId: validBody.expectedActiveProviderRevisionId };
    const response = await f.request(`/api/projects/project-1/revisions/rev-1/cynder/${operation}`, requestBody);
    const body = await response.json() as any;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(expectedStatus);
    expect(body).toMatchObject({ receiptId: operation === 'deploy' ? 'receipt-1' : 'receipt-2', status: 'active' });
    expect(body).toMatchObject({ accessMode: 'public', mcpGrantId: 'grant-1', scopes: ['read', 'deployer'] });
    expect(body).not.toHaveProperty('accessPolicy');
    expect(body).not.toHaveProperty('mcpGrant');
    expect(body.remoteMcpInstallInfo.server).toEqual({
      label: 'open-design-foldy-project-1-grant-1',
      transport: 'streamable-http',
      url: 'https://deploy.example/project-1/mcp',
    });
    expect(body.remoteMcpInstallInfo.clients.gpt).toMatchObject({ supported: true });
    expect(serialized).toContain('OD_FOLDY_MCP_TOKEN');
    expect(serialized).not.toContain(f.tokenSha256);
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('<FOLDY_MCP_TOKEN_SECRET_REF>');
  });
  it('omits remote MCP instructions when the deployment receipt has no binding', async () => {
    const f = await fixture(true);
    const response = await f.request('/api/projects/project-1/revisions/rev-1/cynder/deploy', validBody);
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty('remoteMcpInstallInfo');
  });
});
