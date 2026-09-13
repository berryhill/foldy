import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CynderDeploymentError,
  FoldyCynderDeploymentService,
  HttpCynderDeploymentAdapter,
  type CynderDeploymentAdapter,
  type CynderDeploymentBinding,
  type CynderPreflight,
} from '../src/foldy-deployments/cynder.js';

const roots: string[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const revision = {
  revisionId: 'rev-1', entryFile: 'index.html', bundleSha256: 'a'.repeat(64),
  files: [
    { path: 'index.html', sha256: sha('<h1>ok</h1>'), size: Buffer.byteLength('<h1>ok</h1>') },
    { path: 'about.html', sha256: sha('about'), size: 5 },
  ],
};
const publicProvisioning = {
  accessPolicy: { mode: 'public' } as const,
  mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'] as const, tokenSha256: 'a'.repeat(64) },
};
const defaultAuthority = {
  isRevisionApproved: () => true,
  isCurrentMcpGrant: (_projectId: string, descriptor: typeof publicProvisioning.mcpGrant) =>
    descriptor.grantId === publicProvisioning.mcpGrant.grantId
    && descriptor.tokenSha256 === publicProvisioning.mcpGrant.tokenSha256
    && descriptor.scopes.length === publicProvisioning.mcpGrant.scopes.length
    && descriptor.scopes.every((scope, index) => scope === publicProvisioning.mcpGrant.scopes[index]),
};

class FakeAdapter implements CynderDeploymentAdapter {
  calls: string[] = [];
  active: CynderDeploymentBinding | null = { providerDeploymentId: 'dep-old', providerRevisionId: 'provider-old', projectId: 'project-1', revisionId: 'rev-old', bundleSha256: 'd'.repeat(64), environment: 'production', url: 'https://old.test', mcpUrl: 'https://old.test/mcp', accessMode: 'public' };
  failHealth = false;
  failRollback = false;
  async preflight(_input: Parameters<CynderDeploymentAdapter['preflight']>[0]): Promise<CynderPreflight> { this.calls.push('preflight'); return { accepted: true }; }
  async deployImmutable(input: Parameters<CynderDeploymentAdapter['deployImmutable']>[0]): Promise<CynderDeploymentBinding> { this.calls.push('deploy'); return { providerDeploymentId: 'dep-new', providerRevisionId: 'provider-new', projectId: input.projectId, revisionId: input.revisionId, bundleSha256: input.bundleSha256, environment: input.environment, url: 'https://new.test', mcpUrl: 'https://new.test/mcp', accessMode: input.accessPolicy.mode }; }
  async activate(input: Parameters<CynderDeploymentAdapter['activate']>[0]): Promise<void> { this.calls.push('activate'); if ((this.active?.providerRevisionId ?? null) !== input.expectedProviderRevisionId) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ACTIVE_CONFLICT', 'active deployment changed'); this.active = input.binding; }
  async inspect(): Promise<CynderDeploymentBinding | null> { this.calls.push('inspect'); return this.active; }
  async verifyHealth(): Promise<{ checks: { name: string; ok: boolean }[] }> { this.calls.push('health'); if (this.failHealth) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'health failed'); return { checks: [{ name: 'entry:index.html', ok: true }, { name: 'route:about.html', ok: true }, { name: 'mcp:initialize', ok: true }, { name: 'mcp:list', ok: true }, { name: 'mcp:read', ok: true }] }; }
  async revokeMcpGrant(_input: Parameters<CynderDeploymentAdapter['revokeMcpGrant']>[0]): Promise<void> { this.calls.push('revokeMcpGrant'); }
  rollbackInputs: Parameters<CynderDeploymentAdapter['rollback']>[0][] = [];
  async rollback(input: Parameters<CynderDeploymentAdapter['rollback']>[0]): Promise<void> {
    this.calls.push('rollback');
    this.rollbackInputs.push(input);
    if ((this.active?.providerRevisionId ?? null) !== input.expectedActiveProviderRevisionId) {
      throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ACTIVE_CONFLICT', 'active deployment changed');
    }
    if (this.failRollback) throw new Error('rollback unavailable');
    this.active = input.restore;
  }
}

async function setup(adapter = new FakeAdapter(), authority: {
  approved?: (projectId: string, revisionId: string) => boolean | Promise<boolean>;
  currentGrant?: (projectId: string, descriptor: typeof publicProvisioning.mcpGrant) => boolean | Promise<boolean>;
} = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'foldy-cynder-'));
  roots.push(dataRoot);
  const service = new FoldyCynderDeploymentService({
    dataRoot, adapter, now: () => new Date('2026-09-10T12:00:00.000Z'),
    getRevision: async (_projectId, revisionId) => ({ ...revision, revisionId }),
    readRevisionFile: async (_projectId, _revisionId, file) => Buffer.from(file === 'index.html' ? '<h1>ok</h1>' : 'about'),
    isRevisionApproved: authority.approved ?? (() => true),
    isCurrentMcpGrant: authority.currentGrant ?? (() => true),
  });
  return { service, adapter, dataRoot };
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Foldy exact-revision Cynder deployment', () => {
  it('rejects an unapproved exact revision before any provider call', async () => {
    const { service, adapter } = await setup(new FakeAdapter(), { approved: (_projectId, revisionId) => revisionId !== 'rev-1' });
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'unapproved', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning }))
      .rejects.toMatchObject({ status: 409, code: 'FOLDY_APPROVAL_REQUIRED' });
    expect(adapter.calls).toEqual([]);
  });

  it('requires read and deployer scopes before any provider call', async () => {
    const { service, adapter } = await setup();
    await expect(service.deploy({
      projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'deployer-only', expectedActiveProviderRevisionId: 'provider-old',
      accessPolicy: { mode: 'public' }, mcpGrant: { grantId: 'grant-1', scopes: ['deployer'], tokenSha256: 'a'.repeat(64) },
    })).rejects.toMatchObject({ status: 400, code: 'FOLDY_CYNDER_MCP_SCOPES_REQUIRED' });
    expect(adapter.calls).toEqual([]);
  });

  it('revalidates exact approval and the current grant before recovering a staged deploy', async () => {
    let approved = true; let current = true;
    const { service, adapter, dataRoot } = await setup(new FakeAdapter(), { approved: () => approved, currentGrant: () => current });
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'authority-recovery', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning } as const;
    const completed = await service.deploy(input);
    await rm(path.join(dataRoot, 'foldy-deployments', 'receipts', `${completed.receiptId}.json`));
    adapter.active = completed.priorActive;
    const stagedDir = path.join(dataRoot, 'foldy-deployments', 'staged');
    await mkdir(stagedDir, { recursive: true });
    await writeFile(path.join(stagedDir, 'authority.json'), JSON.stringify({ ...completed, status: 'staged', binding: null, health: null, completedAt: null }));
    adapter.calls.length = 0;
    approved = false;
    await expect(service.recover({ projectId: 'project-1', environment: 'production', receiptId: completed.receiptId })).rejects.toMatchObject({ code: 'FOLDY_APPROVAL_REQUIRED' });
    expect(adapter.calls).toEqual([]);
    approved = true; current = false;
    await expect(service.recover({ projectId: 'project-1', environment: 'production', receiptId: completed.receiptId })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_MCP_GRANT_STALE' });
    expect(adapter.calls).toEqual([]);
  });

  it('rolls back from durable historical evidence without current approval', async () => {
    let approved = true;
    const { service, adapter } = await setup(new FakeAdapter(), { approved: () => approved });
    const deployed = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'approved-target', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    adapter.active = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-latest', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test', mcpUrl: 'https://current.test/mcp', accessMode: 'public' };
    approved = false;
    await expect(service.rollback({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'rollback-unapproved', expectedActiveProviderRevisionId: 'provider-current' }))
      .resolves.toMatchObject({ status: 'rolled_back', binding: deployed.binding });
  });

  it('decodes legacy v1 status safely and marks terminal and legacy receipts non-recoverable', async () => {
    const { service, adapter, dataRoot } = await setup();
    const receipts = path.join(dataRoot, 'foldy-deployments', 'receipts'); const staged = path.join(dataRoot, 'foldy-deployments', 'staged');
    await mkdir(receipts, { recursive: true }); await mkdir(staged, { recursive: true });
    const base = { receiptId: 'legacy-v1', kind: 'deploy', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', idempotencyKey: 'legacy', expectedActiveProviderRevisionId: null, priorActive: null, binding: null, health: null, createdAt: '2026-09-01T00:00:00.000Z', completedAt: null };
    await writeFile(path.join(receipts, 'legacy.json'), JSON.stringify({ schemaVersion: 1, ...base, status: 'active' }));
    await writeFile(path.join(staged, 'failed.json'), JSON.stringify({ schemaVersion: 2, ...base, receiptId: 'failed-v2', status: 'failed', accessPolicy: publicProvisioning.accessPolicy, mcpGrant: publicProvisioning.mcpGrant }));
    adapter.calls.length = 0;
    const status = await service.getStatus('project-1', 'production');
    expect(status.completed[0]).toMatchObject({ schemaVersion: 1, receiptId: 'legacy-v1', accessPolicy: null, mcpGrant: null, recoverable: false });
    expect(status.staged[0]).toMatchObject({ receiptId: 'failed-v2', recoverable: false });
    await expect(service.recover({ projectId: 'project-1', environment: 'production', receiptId: 'failed-v2' })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_RECOVERY_NOT_RECOVERABLE' });
    expect(adapter.calls).toEqual(['inspect']);
  });
  it('reads authoritative provider status with newest-first durable completed and staged receipts', async () => {
    const { service, adapter, dataRoot } = await setup();
    const completed = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'status-completed', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    const staged = { ...completed, receiptId: 'cynder-staged', idempotencyKey: 'status-staged', status: 'staged' as const, createdAt: '2026-09-11T12:00:00.000Z', completedAt: null };
    await mkdir(path.join(dataRoot, 'foldy-deployments', 'staged'), { recursive: true });
    await writeFile(path.join(dataRoot, 'foldy-deployments', 'staged', 'status-staged.json'), JSON.stringify(staged));

    const status = await service.getStatus('project-1', 'production');

    expect(status.binding).toEqual(adapter.active);
    expect(status.completed.map((receipt) => receipt.receiptId)).toEqual([completed.receiptId]);
    expect(status.staged.map((receipt) => receipt.receiptId)).toEqual(['cynder-staged']);
    expect(status.staged[0]?.createdAt).toBe('2026-09-11T12:00:00.000Z');
  });

  it('recovers a persisted pre-provider staged deploy after restart using only its stored descriptors', async () => {
    const { service, adapter, dataRoot } = await setup();
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'restart-recover', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning } as const;
    const completed = await service.deploy(input);
    await rm(path.join(dataRoot, 'foldy-deployments', 'receipts', `${completed.receiptId}.json`));
    adapter.active = completed.priorActive;
    const stagedPath = path.join(dataRoot, 'foldy-deployments', 'staged', `${sha(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`)}.json`);
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, JSON.stringify({ ...completed, status: 'staged', binding: null, health: null, completedAt: null }));
    adapter.calls.length = 0;
    const restarted = new FoldyCynderDeploymentService({ ...defaultAuthority, dataRoot, adapter, getRevision: async () => revision, readRevisionFile: async (_project, _revision, file) => Buffer.from(file === 'index.html' ? '<h1>ok</h1>' : 'about') });

    const recovered = await restarted.recover({ projectId: 'project-1', environment: 'production', receiptId: completed.receiptId });

    expect(recovered).toMatchObject({ receiptId: completed.receiptId, status: 'active', binding: { providerRevisionId: 'provider-new' } });
    expect(adapter.calls).toEqual(['inspect', 'preflight', 'deploy', 'activate', 'inspect', 'health']);
    expect((await restarted.getStatus('project-1', 'production')).completed[0]).toEqual(recovered);
    expect(adapter.active).toEqual(recovered.binding);
  });

  it('re-runs health and exact compensation for an active staged binding after restart', async () => {
    const { service, adapter, dataRoot } = await setup();
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'recover-unhealthy', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning } as const;
    const completed = await service.deploy(input);
    await rm(path.join(dataRoot, 'foldy-deployments', 'receipts', `${completed.receiptId}.json`));
    const stagedPath = path.join(dataRoot, 'foldy-deployments', 'staged', `${sha(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`)}.json`);
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, JSON.stringify({ ...completed, status: 'staged', health: null, completedAt: null }));
    adapter.calls.length = 0; adapter.failHealth = true;
    const restarted = new FoldyCynderDeploymentService({ ...defaultAuthority, dataRoot, adapter, getRevision: async () => revision, readRevisionFile: async () => Buffer.from('unused') });

    await expect(restarted.recover({ projectId: 'project-1', environment: 'production', receiptId: completed.receiptId }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });

    expect(adapter.calls).toEqual(['inspect', 'inspect', 'health', 'inspect', 'rollback', 'inspect']);
    expect(adapter.rollbackInputs.at(-1)).toMatchObject({ failed: completed.binding, restore: completed.priorActive, expectedActiveProviderRevisionId: 'provider-new' });
    expect(adapter.active).toEqual(completed.priorActive);
    const status = await restarted.getStatus('project-1', 'production');
    expect(status.completed[0]).toMatchObject({ receiptId: completed.receiptId, status: 'failed', errorCode: 'FOLDY_CYNDER_HEALTH_FAILED' });
    expect(status.staged).toEqual([]);
  });

  it('returns exact missing, ambiguous, and mismatched recovery blockers without provider mutation', async () => {
    const { service, adapter, dataRoot } = await setup();
    await expect(service.recover({ projectId: 'project-1', environment: 'production' }))
      .rejects.toMatchObject({ status: 404, code: 'FOLDY_CYNDER_RECOVERY_NOT_FOUND' });

    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'recovery-candidate', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning } as const;
    const completed = await service.deploy(input);
    const stagedDir = path.join(dataRoot, 'foldy-deployments', 'staged');
    await mkdir(stagedDir, { recursive: true });
    const staged = { ...completed, status: 'staged' as const, completedAt: null };
    await writeFile(path.join(stagedDir, 'one.json'), JSON.stringify(staged));
    await writeFile(path.join(stagedDir, 'two.json'), JSON.stringify(staged));
    adapter.calls.length = 0;

    await expect(service.recover({ projectId: 'project-1', environment: 'production' }))
      .rejects.toMatchObject({ status: 409, code: 'FOLDY_CYNDER_RECOVERY_AMBIGUOUS' });
    await expect(service.recover({ projectId: 'project-other', environment: 'production', receiptId: completed.receiptId }))
      .rejects.toMatchObject({ status: 409, code: 'FOLDY_CYNDER_RECOVERY_MISMATCH' });
    expect(adapter.calls).toEqual([]);
  });

  it('passes the exact project-bound grant digest through the deployment service', async () => {
    const { service, adapter } = await setup();
    const descriptor = { grantId: 'grant-1', tokenSha256: 'a'.repeat(64), projectId: 'project-1' };
    const revoke = vi.spyOn(adapter, 'revokeMcpGrant');

    await expect(service.revokeMcpGrant(descriptor)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(descriptor);
  });

  it('posts only the grant digest and project identity to the authenticated provider revoke endpoint', async () => {
    const envName = `CYNDER_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
    const credential = randomUUID();
    const rawToken = randomUUID();
    process.env[envName] = credential;
    try {
      const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ revoked: true }));
      const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: envName, fetch: fetcher });
      const descriptor = { grantId: 'grant-1', tokenSha256: sha(rawToken), projectId: 'project-1' };

      await adapter.revokeMcpGrant(descriptor);
      await adapter.revokeMcpGrant(descriptor);

      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const call of fetcher.mock.calls) {
        expect(call[0]).toBe('https://provider.example/v1/foldy/mcp/grants/revoke');
        expect(call[1]).toMatchObject({ method: 'POST', headers: { authorization: `Bearer ${credential}` }, signal: expect.any(AbortSignal) });
        expect(JSON.parse(String(call[1]?.body))).toEqual(descriptor);
        expect(String(call[1]?.body)).not.toContain(rawToken);
      }
    } finally {
      delete process.env[envName];
    }
  });

  it('sanitizes provider revoke failures and preserves timeout typing', async () => {
    const rejected = new HttpCynderDeploymentAdapter({
      endpoint: 'https://provider.example', secretEnv: 'PATH',
      fetch: vi.fn(async () => Response.json({ error: { code: 'RAW_PROVIDER_CODE', message: 'provider internals' } }, { status: 500 })),
    });
    await expect(rejected.revokeMcpGrant({ grantId: 'grant-1', tokenSha256: 'a'.repeat(64), projectId: 'project-1' }))
      .rejects.toMatchObject({ status: 502, code: 'FOLDY_CYNDER_PROVIDER_FAILED', message: 'Cynder provider request failed' });

    const timedOut = new HttpCynderDeploymentAdapter({
      endpoint: 'https://provider.example', secretEnv: 'PATH', timeoutMs: 5,
      fetch: vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch,
    });
    await expect(timedOut.revokeMcpGrant({ grantId: 'grant-1', tokenSha256: 'a'.repeat(64), projectId: 'project-1' }))
      .rejects.toMatchObject({ status: 504, code: 'FOLDY_CYNDER_PROVIDER_TIMEOUT', message: 'Cynder provider request timed out' });
  });

  it('provisions access and MCP in provider payloads and canonical identity without plaintext secrets', async () => {
    const { service, adapter, dataRoot } = await setup();
    const password = randomUUID();
    const rawToken = randomUUID();
    const accessPolicy = { mode: 'password_required', passwordScryptVerifier: `scrypt$16384$8$1$${sha(password).slice(0, 32)}$${sha(password)}` } as const;
    const mcpGrant = { grantId: 'grant-1', scopes: ['read', 'deployer'] as const, tokenSha256: sha(rawToken) };
    const preflight = vi.spyOn(adapter, 'preflight');
    const deployImmutable = vi.spyOn(adapter, 'deployImmutable');
    const receipt = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'provisioned', expectedActiveProviderRevisionId: 'provider-old', accessPolicy, mcpGrant });
    for (const payload of [preflight.mock.calls[0]?.[0], deployImmutable.mock.calls[0]?.[0]]) {
      expect(payload).toMatchObject({ accessPolicy, mcpGrant });
      expect(JSON.stringify(payload)).not.toContain(password);
      expect(JSON.stringify(payload)).not.toContain(rawToken);
    }
    const persisted = await readFile(path.join(dataRoot, 'foldy-deployments', 'receipts', receipt.receiptId + '.json'), 'utf8');
    expect(persisted).not.toContain(password);
    expect(persisted).not.toContain(rawToken);
  });

  it('includes access and MCP descriptors in canonical idempotency identity', async () => {
    const first = await setup();
    const base = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'identity', expectedActiveProviderRevisionId: 'provider-old', accessPolicy: { mode: 'public' } as const };
    const one = await first.service.deploy({ ...base, mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'] as const, tokenSha256: 'a'.repeat(64) } });
    const second = await setup();
    const two = await second.service.deploy({ ...base, mcpGrant: { grantId: 'grant-2', scopes: ['read', 'deployer'] as const, tokenSha256: 'b'.repeat(64) } });
    expect(one.receiptId).not.toBe(two.receiptId);
  });

  const invalidBindings: Array<[Record<string, unknown>, string]> = [
    [{ mcpUrl: undefined }, 'missing mcpUrl'],
    [{ accessMode: 'public' }, 'access mismatch'],
    [{ providerDeploymentId: undefined }, 'missing providerDeploymentId'],
    [{ providerDeploymentId: '' }, 'empty providerDeploymentId'],
    [{ providerDeploymentId: '   ' }, 'whitespace providerDeploymentId'],
    [{ providerDeploymentId: '..' }, 'traversal providerDeploymentId'],
    [{ providerDeploymentId: 'dep/../other' }, 'path providerDeploymentId'],
    [{ providerDeploymentId: 'dep\u0000other' }, 'control providerDeploymentId'],
    [{ providerDeploymentId: 'dep@provider' }, 'malformed providerDeploymentId'],
    [{ providerDeploymentId: `dep-${'a'.repeat(128)}` }, 'overlong providerDeploymentId'],
    [{ providerRevisionId: undefined }, 'missing providerRevisionId'],
    [{ providerRevisionId: '' }, 'empty providerRevisionId'],
    [{ providerRevisionId: '\t' }, 'whitespace providerRevisionId'],
    [{ providerRevisionId: '.' }, 'traversal providerRevisionId'],
    [{ providerRevisionId: '../revision' }, 'path providerRevisionId'],
    [{ providerRevisionId: 'revision\nother' }, 'control providerRevisionId'],
    [{ providerRevisionId: 'revision:provider' }, 'malformed providerRevisionId'],
    [{ providerRevisionId: `revision-${'b'.repeat(128)}` }, 'overlong providerRevisionId'],
  ];
  it.each(invalidBindings)('rejects provider binding with %s (%s)', async (bindingOverride) => {
    class InvalidBindingAdapter extends FakeAdapter {
      override async deployImmutable(input: Parameters<CynderDeploymentAdapter['deployImmutable']>[0]): Promise<CynderDeploymentBinding> {
        const valid = await super.deployImmutable(input);
        return { ...valid, mcpUrl: 'https://new.test/mcp', accessMode: 'password_required', ...bindingOverride } as CynderDeploymentBinding;
      }
    }
    const { service, adapter, dataRoot } = await setup(new InvalidBindingAdapter());
    await expect(service.deploy({
      projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: randomUUID(), expectedActiveProviderRevisionId: 'provider-old',
      accessPolicy: { mode: 'password_required', passwordScryptVerifier: `scrypt$16384$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}` },
      mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'], tokenSha256: 'c'.repeat(64) },
    })).rejects.toMatchObject({ status: 502, code: 'FOLDY_CYNDER_BINDING_MISMATCH' });
    expect(adapter.calls).not.toContain('activate');
    const stagedDir = path.join(dataRoot, 'foldy-deployments', 'staged');
    const stagedFiles = await readdir(stagedDir);
    for (const file of stagedFiles) {
      expect(JSON.parse(await readFile(path.join(stagedDir, file), 'utf8')).binding).toBeNull();
    }
  });

  it('persists a realistic provider binding that still decodes after service restart', async () => {
    class RealisticProviderIdsAdapter extends FakeAdapter {
      override async deployImmutable(input: Parameters<CynderDeploymentAdapter['deployImmutable']>[0]): Promise<CynderDeploymentBinding> {
        return {
          ...await super.deployImmutable(input),
          providerDeploymentId: 'dpl_2Yk9Z-example.Prod-01',
          providerRevisionId: 'rev_01J8Y4N7Q9-alpha.2',
        };
      }
    }
    const { service, adapter, dataRoot } = await setup(new RealisticProviderIdsAdapter());
    const receipt = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'restart-decode', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    const restarted = new FoldyCynderDeploymentService({ ...defaultAuthority, dataRoot, adapter, getRevision: async () => revision, readRevisionFile: async () => Buffer.from('unused') });

    const status = await restarted.getStatus('project-1', 'production');

    expect(status.completed).toHaveLength(1);
    expect(status.completed[0]).toEqual(receipt);
    expect(status.completed[0]?.binding).toMatchObject({ providerDeploymentId: 'dpl_2Yk9Z-example.Prod-01', providerRevisionId: 'rev_01J8Y4N7Q9-alpha.2' });
  });

  it('preflights, immutably deploys, CAS activates, verifies all health surfaces, and persists a final receipt', async () => {
    const { service, adapter, dataRoot } = await setup();
    const receipt = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    expect(receipt.status).toBe('active');
    expect(receipt.bundleSha256).toBe(revision.bundleSha256);
    expect(adapter.calls).toEqual(['inspect', 'preflight', 'deploy', 'activate', 'inspect', 'health']);
    expect(JSON.parse(await readFile(path.join(dataRoot, 'foldy-deployments', 'receipts', receipt.receiptId + '.json'), 'utf8'))).toEqual(receipt);
  });

  it('rejects activation when provider inspection changes the provisioned access or MCP binding', async () => {
    class ChangedProvisioningBindingAdapter extends FakeAdapter {
      override async activate(input: Parameters<CynderDeploymentAdapter['activate']>[0]): Promise<void> {
        await super.activate(input);
        this.active = { ...input.binding, mcpUrl: 'https://changed.test/mcp' };
      }
    }
    const { service, adapter } = await setup(new ChangedProvisioningBindingAdapter());
    await expect(service.deploy({
      projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'changed-provisioning-binding',
      expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning,
    })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_ACTIVE_CONFLICT', rollbackFailed: true });
    expect(adapter.calls).not.toContain('health');
  });

  it('returns the byte-equivalent prior receipt on replay without provider mutation', async () => {
    const { service, adapter } = await setup();
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning } as const;
    const first = await service.deploy(input); const calls = [...adapter.calls]; const replay = await service.deploy(input);
    expect(replay).toEqual(first); expect(adapter.calls).toEqual(calls);
  });

  it('rejects stale CAS before deployImmutable', async () => {
    const { service, adapter } = await setup();
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'stale', ...publicProvisioning })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_ACTIVE_CONFLICT' });
    expect(adapter.calls).toEqual(['inspect']);
  });

  it('rolls provider state back and preserves the prior active deployment when health fails', async () => {
    const { service, adapter } = await setup(); adapter.failHealth = true;
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });
    expect(adapter.calls).toEqual(['inspect', 'preflight', 'deploy', 'activate', 'inspect', 'health', 'inspect', 'rollback', 'inspect']);
    expect(adapter.rollbackInputs[0]?.expectedActiveProviderRevisionId).toBe('provider-new');
    expect(adapter.active?.providerRevisionId).toBe('provider-old');
  });

  it('compensates an unhealthy explicit rollback to the exact prior binding', async () => {
    const { service, adapter } = await setup();
    await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'deploy-target', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    const current = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-current', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test', mcpUrl: 'https://current.test/mcp', accessMode: 'public' } as const;
    adapter.active = current;
    adapter.failHealth = true;

    await expect(service.rollback({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'rollback-unhealthy', expectedActiveProviderRevisionId: 'provider-current', ...publicProvisioning }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });

    expect(adapter.rollbackInputs).toHaveLength(2);
    expect(adapter.rollbackInputs[1]).toMatchObject({ failed: expect.objectContaining({ providerRevisionId: 'provider-new' }), restore: current, expectedActiveProviderRevisionId: 'provider-new' });
    expect(adapter.active).toEqual(current);
  });

  it('marks deploy compensation rollback_failed when exact null restoration cannot be verified', async () => {
    class NullRestoreMismatchAdapter extends FakeAdapter {
      override active: CynderDeploymentBinding | null = null;
      override async inspect(): Promise<CynderDeploymentBinding | null> {
        this.calls.push('inspect');
        if (this.rollbackInputs.length > 0) return { providerDeploymentId: 'dep-unexpected', providerRevisionId: 'provider-unexpected', projectId: 'project-1', revisionId: 'rev-unexpected', bundleSha256: 'f'.repeat(64), environment: 'production', url: 'https://unexpected.test', mcpUrl: 'https://unexpected.test/mcp', accessMode: 'public' };
        return this.active;
      }
    }
    const adapter = new NullRestoreMismatchAdapter();
    adapter.failHealth = true;
    const { service, dataRoot } = await setup(adapter);

    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'null-restore-mismatch', expectedActiveProviderRevisionId: null, ...publicProvisioning }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED', rollbackFailed: true });

    const stagedFiles = await import('node:fs/promises').then((fs) => fs.readdir(path.join(dataRoot, 'foldy-deployments', 'staged')));
    const staged = JSON.parse(await readFile(path.join(dataRoot, 'foldy-deployments', 'staged', stagedFiles[0]!), 'utf8'));
    expect(staged.status).toBe('rollback_failed');
    expect(adapter.calls.slice(-2)).toEqual(['rollback', 'inspect']);
  });

  it('records rollback failure without masking the deployment failure', async () => {
    const { service, adapter, dataRoot } = await setup(); adapter.failHealth = true; adapter.failRollback = true;
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED', rollbackFailed: true });
    const stagedFiles = await import('node:fs/promises').then((fs) => fs.readdir(path.join(dataRoot, 'foldy-deployments', 'staged')));
    const staged = JSON.parse(await readFile(path.join(dataRoot, 'foldy-deployments', 'staged', stagedFiles[0]!), 'utf8'));
    expect(staged.status).toBe('rollback_failed');
  });

  it('refuses rollback when no durable receipt contains the requested provider binding', async () => {
    const { service, adapter } = await setup();
    await expect(service.rollback({ projectId: 'project-1', revisionId: 'rev-old', environment: 'production', idempotencyKey: 'rollback-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_ROLLBACK_BINDING_UNKNOWN' });
    expect(adapter.calls).toEqual(['inspect']);
  });

  it('rejects plaintext provider HTTP except explicit loopback endpoints', () => {
    expect(() => new HttpCynderDeploymentAdapter({ endpoint: 'http://provider.example', secretEnv: 'CYNDER_TOKEN' }))
      .toThrow(/HTTPS/);
    expect(() => new HttpCynderDeploymentAdapter({ endpoint: 'http://127.0.0.1:8080', secretEnv: 'CYNDER_TOKEN' }))
      .not.toThrow();
  });

  it('reconciles a durable staged receipt to terminal active truth after restart', async () => {
    const { service, adapter, dataRoot } = await setup();
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning } as const;
    const completed = await service.deploy(input);
    const finalPath = path.join(dataRoot, 'foldy-deployments', 'receipts', `${completed.receiptId}.json`);
    await rm(finalPath);
    const key = sha(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`);
    const stagedPath = path.join(dataRoot, 'foldy-deployments', 'staged', `${key}.json`);
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, JSON.stringify({ ...completed, status: 'staged', completedAt: null }));

    const restarted = new FoldyCynderDeploymentService({
      ...defaultAuthority,
      dataRoot, adapter,
      getRevision: async () => revision,
      readRevisionFile: async () => Buffer.from('unused'),
    });
    const reconciled = await restarted.deploy(input);
    expect(reconciled.status).toBe('active');
    expect(reconciled.binding).toEqual(completed.binding);
    expect(JSON.parse(await readFile(finalPath, 'utf8'))).toEqual(reconciled);
  });

  it('replays the exact final receipt after service restart', async () => {
    const { service, adapter, dataRoot } = await setup();
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning } as const;
    const first = await service.deploy(input);
    const restarted = new FoldyCynderDeploymentService({ ...defaultAuthority, dataRoot, adapter, getRevision: async () => revision, readRevisionFile: async () => Buffer.from('unused') });
    const replay = await restarted.deploy(input);
    expect(replay).toEqual(first); expect(adapter.calls).toEqual(['inspect', 'preflight', 'deploy', 'activate', 'inspect', 'health']);
  });

  it('serializes different idempotency keys for the same project and environment through compensation', async () => {
    let enterFirstHealth!: () => void;
    let releaseFirstHealth!: () => void;
    const entered = new Promise<void>((resolve) => { enterFirstHealth = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirstHealth = resolve; });
    class BlockingAdapter extends FakeAdapter {
      healthCalls = 0;
      override async deployImmutable(input: Parameters<CynderDeploymentAdapter['deployImmutable']>[0]) {
        this.calls.push('deploy');
        return { providerDeploymentId: `dep-${input.revisionId}`, providerRevisionId: `provider-${input.revisionId}`, projectId: input.projectId, revisionId: input.revisionId, bundleSha256: input.bundleSha256, environment: input.environment, url: 'https://new.test', mcpUrl: 'https://new.test/mcp', accessMode: input.accessPolicy.mode };
      }
      override async verifyHealth() {
        this.calls.push('health');
        if (++this.healthCalls === 1) { enterFirstHealth(); await release; throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'health failed'); }
        return { checks: [{ name: 'mcp:read', ok: true }] };
      }
    }
    const adapter = new BlockingAdapter();
    const { service } = await setup(adapter);
    const first = service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    await entered;
    const second = service.deploy({ projectId: 'project-1', revisionId: 'rev-2', environment: 'production', idempotencyKey: 'request-2', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    await Promise.resolve();
    expect(adapter.calls.filter((call) => call === 'deploy')).toHaveLength(1);
    releaseFirstHealth();
    await expect(first).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });
    await expect(second).resolves.toMatchObject({ status: 'active', revisionId: 'rev-2' });
    expect(adapter.active?.revisionId).toBe('rev-2');
  });

  it('does not compensate over a provider binding that changed after the failed activation', async () => {
    class ChangedActiveAdapter extends FakeAdapter {
      override async verifyHealth(): Promise<{ checks: { name: string; ok: boolean }[] }> {
        this.calls.push('health');
        this.active = { providerDeploymentId: 'dep-other', providerRevisionId: 'provider-other', projectId: 'project-1', revisionId: 'rev-other', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://other.test', mcpUrl: 'https://other.test/mcp', accessMode: 'public' };
        throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'health failed');
      }
    }
    const adapter = new ChangedActiveAdapter(); const { service } = await setup(adapter);
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED', rollbackFailed: true });
    expect(adapter.calls.at(-1)).toBe('inspect');
    expect(adapter.calls).not.toContain('rollback');
    expect(adapter.active?.providerRevisionId).toBe('provider-other');
  });

  it('requires provider-atomic CAS when compensation races an external activation', async () => {
    class RacedCompensationAdapter extends FakeAdapter {
      override async rollback(input: Parameters<CynderDeploymentAdapter['rollback']>[0]): Promise<void> {
        this.active = {
          providerDeploymentId: 'dep-external',
          providerRevisionId: 'provider-external',
          projectId: 'project-1',
          revisionId: 'rev-external',
          bundleSha256: 'e'.repeat(64),
          environment: 'production',
          url: 'https://external.test',
          mcpUrl: 'https://external.test/mcp',
          accessMode: 'public',
        };
        await super.rollback(input);
      }
    }
    const adapter = new RacedCompensationAdapter();
    adapter.failHealth = true;
    const { service } = await setup(adapter);
    await expect(service.deploy({
      projectId: 'project-1',
      revisionId: 'rev-1',
      environment: 'production',
      idempotencyKey: 'request-raced-compensation',
      expectedActiveProviderRevisionId: 'provider-old',
      ...publicProvisioning,
    })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED', rollbackFailed: true });
    expect(adapter.rollbackInputs[0]?.expectedActiveProviderRevisionId).toBe('provider-new');
    expect(adapter.active?.providerRevisionId).toBe('provider-external');
  });

  it('durably stages the exact restore binding and records rollback as rolled_back', async () => {
    const { service, adapter, dataRoot } = await setup();
    const deployed = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'deploy-target', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    adapter.active = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-current', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test', mcpUrl: 'https://current.test/mcp', accessMode: 'public' };
    adapter.rollback = async (input) => {
      adapter.calls.push('rollback');
      const files = await import('node:fs/promises').then((fs) => fs.readdir(path.join(dataRoot, 'foldy-deployments', 'staged')));
      const staged = JSON.parse(await readFile(path.join(dataRoot, 'foldy-deployments', 'staged', files[0]!), 'utf8'));
      expect(staged.binding).toEqual(input.restore);
      adapter.active = input.restore;
    };
    const receipt = await service.rollback({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'rollback-target', expectedActiveProviderRevisionId: 'provider-current', ...publicProvisioning });
    expect(receipt.status).toBe('rolled_back');
    expect(receipt.binding).toEqual(deployed.binding);
  });

  it('restores the historical receipt provisioning tuple instead of caller-selected replacements', async () => {
    const { service, adapter } = await setup();
    const historicalProvisioning = {
      accessPolicy: { mode: 'password_required', passwordScryptVerifier: `scrypt$16384$8$1$${'1'.repeat(32)}$${'2'.repeat(64)}` } as const,
      mcpGrant: { grantId: 'historical-grant', scopes: ['read', 'deployer'] as const, tokenSha256: '3'.repeat(64) },
    };
    const deployed = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'historical-tuple', expectedActiveProviderRevisionId: 'provider-old', ...historicalProvisioning });
    adapter.active = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-current', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test', mcpUrl: 'https://current.test/mcp', accessMode: 'public' };

    const receipt = await service.rollback({
      projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'restore-historical-tuple', expectedActiveProviderRevisionId: 'provider-current',
    });

    expect(receipt).toMatchObject({ binding: deployed.binding, ...historicalProvisioning });
    expect(receipt.mcpGrant?.tokenSha256).not.toBe('4'.repeat(64));
  });

  it('rejects ambiguous rollback receipts whose provisioning token hashes differ', async () => {
    const { service, adapter } = await setup();
    await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'candidate-one', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    await service.deploy({
      projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'candidate-two', expectedActiveProviderRevisionId: 'provider-new',
      accessPolicy: { mode: 'public' }, mcpGrant: { grantId: 'grant-1', scopes: ['read', 'deployer'], tokenSha256: 'b'.repeat(64) },
    });
    adapter.active = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-current', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test', mcpUrl: 'https://current.test/mcp', accessMode: 'public' };

    await expect(service.rollback({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'ambiguous-token', expectedActiveProviderRevisionId: 'provider-current', ...publicProvisioning }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_ROLLBACK_BINDING_UNKNOWN' });
  });

  it('reconciles and health-checks an exact staged rollback after restart', async () => {
    const { service, adapter, dataRoot } = await setup();
    await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'deploy-target', expectedActiveProviderRevisionId: 'provider-old', ...publicProvisioning });
    adapter.active = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-current', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test', mcpUrl: 'https://current.test/mcp', accessMode: 'public' };
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'rollback-target', expectedActiveProviderRevisionId: 'provider-current', ...publicProvisioning } as const;
    const completed = await service.rollback(input);
    const finalPath = path.join(dataRoot, 'foldy-deployments', 'receipts', `${completed.receiptId}.json`);
    await rm(finalPath);
    const stagedPath = path.join(dataRoot, 'foldy-deployments', 'staged', `${sha(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`)}.json`);
    await writeFile(stagedPath, JSON.stringify({ ...completed, status: 'staged', health: null, completedAt: null }));
    adapter.calls.length = 0;
    const restarted = new FoldyCynderDeploymentService({ ...defaultAuthority, dataRoot, adapter, getRevision: async () => revision, readRevisionFile: async () => Buffer.from('unused') });
    const reconciled = await restarted.rollback(input);
    expect(reconciled.status).toBe('rolled_back');
    expect(reconciled.binding).toEqual(completed.binding);
    expect(adapter.calls).toEqual(['inspect', 'health']);
  });

  it.each([
    'https://user@deploy.example',
    'https://deploy.example/path?next=http://127.0.0.1',
    'https://deploy.example:8443',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://169.254.169.254',
    'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]',
    'https://224.0.0.1',
    'http://deploy.example',
    'https://unapproved.example',
  ])('rejects malicious provider deployment URL %s before health fetches', async (url) => {
    const fetcher = vi.fn();
    const providerHost = new URL(url).hostname;
    const deploymentHosts = providerHost === 'unapproved.example' ? ['deploy.example'] : ['deploy.example', providerHost];
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts, fetch: fetcher });
    const binding: CynderDeploymentBinding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url, mcpUrl: 'https://deploy.example/mcp', accessMode: 'public' };
    await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_BINDING_URL_REJECTED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses one authenticated control-plane health request and strictly decodes semantic checks', async () => {
    const envName = `CYNDER_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
    const credential = randomUUID();
    process.env[envName] = credential;
    try {
      const checks = [
        { name: 'entry:index.html', ok: true, status: 200 },
        { name: 'route:about.html', ok: true, status: 200 },
        { name: 'mcp:initialize', ok: true, status: 200 },
        { name: 'mcp:list', ok: true, status: 200 },
        { name: 'mcp:read', ok: true, status: 200 },
      ];
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${credential}` });
        expect(init?.body).not.toContain(credential);
        return Response.json({ checks });
      });
      const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: envName, deploymentHosts: ['deploy.example'], fetch: fetcher as typeof fetch });
      const binding: CynderDeploymentBinding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'https://deploy.example', mcpUrl: 'https://deploy.example/mcp', accessMode: 'public' };

      await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: ['about.html'] })).resolves.toEqual({ checks });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith('https://provider.example/v1/foldy/deployments/health', expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ binding: { ...binding, url: 'https://deploy.example/' }, entryFile: 'index.html', declaredRoutes: ['about.html'] });
    } finally {
      delete process.env[envName];
    }
  });

  it('rejects semantic health results missing MCP read success', async () => {
    const fetcher = vi.fn(async () => Response.json({ checks: [
      { name: 'entry:index.html', ok: true },
      { name: 'mcp:initialize', ok: true },
      { name: 'mcp:list', ok: true },
    ] }));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['deploy.example'], fetch: fetcher });
    const binding: CynderDeploymentBinding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'https://deploy.example', mcpUrl: 'https://deploy.example/mcp', accessMode: 'public' };

    await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('maps a bounded provider request timeout to a stable sanitized error', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', timeoutMs: 5, fetch: fetcher as typeof fetch });

    await expect(adapter.preflight({ projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', idempotencyKey: 'timeout', entryFile: 'index.html', declaredRoutes: [], ...publicProvisioning }))
      .rejects.toMatchObject({ status: 504, code: 'FOLDY_CYNDER_PROVIDER_TIMEOUT', message: 'Cynder provider request timed out' });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a malicious immutable deployment binding before it can be activated', async () => {
    const binding: CynderDeploymentBinding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'https://127.0.0.1', mcpUrl: 'https://127.0.0.1/mcp', accessMode: 'public' };
    const fetcher = vi.fn(async () => Response.json(binding));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['127.0.0.1'], fetch: fetcher });
    await expect(adapter.deployImmutable({ projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', idempotencyKey: 'receipt-1', entryFile: 'index.html', files: [], ...publicProvisioning }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_BINDING_URL_REJECTED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(invalidBindings.filter(([override]) => 'providerDeploymentId' in override || 'providerRevisionId' in override))(
    'rejects provider identity %s (%s) consistently from immutable, inspect, and health paths',
    async (bindingOverride) => {
      const binding = {
        providerDeploymentId: 'dpl_2Yk9Z-example.Prod-01',
        providerRevisionId: 'rev_01J8Y4N7Q9-alpha.2',
        projectId: 'project-1',
        revisionId: 'rev-1',
        bundleSha256: 'a'.repeat(64),
        environment: 'production',
        url: 'https://deploy.example',
        mcpUrl: 'https://deploy.example/mcp',
        accessMode: 'public',
        ...bindingOverride,
      } as CynderDeploymentBinding;
      const fetcher = vi.fn(async () => Response.json(binding));
      const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['deploy.example'], fetch: fetcher });

      await expect(adapter.deployImmutable({ projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', idempotencyKey: 'receipt-1', entryFile: 'index.html', files: [], ...publicProvisioning }))
        .rejects.toMatchObject({ status: 502, code: 'FOLDY_CYNDER_BINDING_MISMATCH' });
      await expect(adapter.inspect({ projectId: 'project-1', environment: 'production' }))
        .rejects.toMatchObject({ status: 502, code: 'FOLDY_CYNDER_BINDING_MISMATCH' });
      fetcher.mockClear();
      await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] }))
        .rejects.toMatchObject({ status: 502, code: 'FOLDY_CYNDER_BINDING_MISMATCH' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('accepts HTTP only as an explicitly configured provider binding identity without fetching it directly', async () => {
    const checks = [{ name: 'entry:index.html', ok: true }, { name: 'mcp:initialize', ok: true }, { name: 'mcp:list', ok: true }, { name: 'mcp:read', ok: true }];
    const fetcher = vi.fn(async () => Response.json({ checks }));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['deploy.example'], allowHttpDeploymentHosts: ['deploy.example'], fetch: fetcher });
    const binding: CynderDeploymentBinding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'http://deploy.example', mcpUrl: 'http://deploy.example/mcp', accessMode: 'public' };
    await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] })).resolves.toEqual({ checks });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://provider.example/v1/foldy/deployments/health', expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects control-plane redirects and never follows them to a binding host', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 302, headers: { location: 'http://127.0.0.1' } }));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['deploy.example'], fetch: fetcher });
    const binding: CynderDeploymentBinding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'https://deploy.example', mcpUrl: 'https://deploy.example/mcp', accessMode: 'public' };
    await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_PROVIDER_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://provider.example/v1/foldy/deployments/health', expect.objectContaining({ redirect: 'error' }));
  });
});
