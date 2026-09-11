import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

class FakeAdapter implements CynderDeploymentAdapter {
  calls: string[] = [];
  active: CynderDeploymentBinding | null = { providerDeploymentId: 'dep-old', providerRevisionId: 'provider-old', projectId: 'project-1', revisionId: 'rev-old', bundleSha256: 'd'.repeat(64), environment: 'production', url: 'https://old.test' };
  failHealth = false;
  failRollback = false;
  async preflight(): Promise<CynderPreflight> { this.calls.push('preflight'); return { accepted: true }; }
  async deployImmutable(input: Parameters<CynderDeploymentAdapter['deployImmutable']>[0]): Promise<CynderDeploymentBinding> { this.calls.push('deploy'); return { providerDeploymentId: 'dep-new', providerRevisionId: 'provider-new', projectId: input.projectId, revisionId: input.revisionId, bundleSha256: input.bundleSha256, environment: input.environment, url: 'https://new.test' }; }
  async activate(input: Parameters<CynderDeploymentAdapter['activate']>[0]): Promise<void> { this.calls.push('activate'); if ((this.active?.providerRevisionId ?? null) !== input.expectedProviderRevisionId) throw new CynderDeploymentError(409, 'FOLDY_CYNDER_ACTIVE_CONFLICT', 'active deployment changed'); this.active = input.binding; }
  async inspect(): Promise<CynderDeploymentBinding | null> { this.calls.push('inspect'); return this.active; }
  async verifyHealth(): Promise<{ checks: { name: string; ok: boolean }[] }> { this.calls.push('health'); if (this.failHealth) throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'health failed'); return { checks: [{ name: 'entry:index.html', ok: true }, { name: 'route:about.html', ok: true }, { name: 'mcp:initialize', ok: true }, { name: 'mcp:list', ok: true }, { name: 'mcp:read', ok: true }] }; }
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

async function setup(adapter = new FakeAdapter()) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'foldy-cynder-'));
  roots.push(dataRoot);
  const service = new FoldyCynderDeploymentService({
    dataRoot, adapter, now: () => new Date('2026-09-10T12:00:00.000Z'),
    getRevision: async (_projectId, revisionId) => ({ ...revision, revisionId }),
    readRevisionFile: async (_projectId, _revisionId, file) => Buffer.from(file === 'index.html' ? '<h1>ok</h1>' : 'about'),
  });
  return { service, adapter, dataRoot };
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Foldy exact-revision Cynder deployment', () => {
  it('preflights, immutably deploys, CAS activates, verifies all health surfaces, and persists a final receipt', async () => {
    const { service, adapter, dataRoot } = await setup();
    const receipt = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' });
    expect(receipt.status).toBe('active');
    expect(receipt.bundleSha256).toBe(revision.bundleSha256);
    expect(adapter.calls).toEqual(['inspect', 'preflight', 'deploy', 'activate', 'inspect', 'health']);
    expect(JSON.parse(await readFile(path.join(dataRoot, 'foldy-deployments', 'receipts', receipt.receiptId + '.json'), 'utf8'))).toEqual(receipt);
  });

  it('returns the byte-equivalent prior receipt on replay without provider mutation', async () => {
    const { service, adapter } = await setup();
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' } as const;
    const first = await service.deploy(input); const calls = [...adapter.calls]; const replay = await service.deploy(input);
    expect(replay).toEqual(first); expect(adapter.calls).toEqual(calls);
  });

  it('rejects stale CAS before deployImmutable', async () => {
    const { service, adapter } = await setup();
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'stale' })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_ACTIVE_CONFLICT' });
    expect(adapter.calls).toEqual(['inspect']);
  });

  it('rolls provider state back and preserves the prior active deployment when health fails', async () => {
    const { service, adapter } = await setup(); adapter.failHealth = true;
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });
    expect(adapter.calls).toEqual(['inspect', 'preflight', 'deploy', 'activate', 'inspect', 'health', 'inspect', 'rollback']);
    expect(adapter.rollbackInputs[0]?.expectedActiveProviderRevisionId).toBe('provider-new');
    expect(adapter.active?.providerRevisionId).toBe('provider-old');
  });

  it('records rollback failure without masking the deployment failure', async () => {
    const { service, adapter, dataRoot } = await setup(); adapter.failHealth = true; adapter.failRollback = true;
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED', rollbackFailed: true });
    const stagedFiles = await import('node:fs/promises').then((fs) => fs.readdir(path.join(dataRoot, 'foldy-deployments', 'staged')));
    const staged = JSON.parse(await readFile(path.join(dataRoot, 'foldy-deployments', 'staged', stagedFiles[0]!), 'utf8'));
    expect(staged.status).toBe('rollback_failed');
  });

  it('refuses rollback when no durable receipt contains the requested provider binding', async () => {
    const { service, adapter } = await setup();
    await expect(service.rollback({ projectId: 'project-1', revisionId: 'rev-old', environment: 'production', idempotencyKey: 'rollback-1', expectedActiveProviderRevisionId: 'provider-old' }))
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
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' } as const;
    const completed = await service.deploy(input);
    const finalPath = path.join(dataRoot, 'foldy-deployments', 'receipts', `${completed.receiptId}.json`);
    await rm(finalPath);
    const key = sha(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`);
    const stagedPath = path.join(dataRoot, 'foldy-deployments', 'staged', `${key}.json`);
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, JSON.stringify({ ...completed, status: 'staged', completedAt: null }));

    const restarted = new FoldyCynderDeploymentService({
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
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' } as const;
    const first = await service.deploy(input);
    const restarted = new FoldyCynderDeploymentService({ dataRoot, adapter, getRevision: async () => revision, readRevisionFile: async () => Buffer.from('unused') });
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
        return { providerDeploymentId: `dep-${input.revisionId}`, providerRevisionId: `provider-${input.revisionId}`, projectId: input.projectId, revisionId: input.revisionId, bundleSha256: input.bundleSha256, environment: input.environment, url: 'https://new.test' };
      }
      override async verifyHealth() {
        this.calls.push('health');
        if (++this.healthCalls === 1) { enterFirstHealth(); await release; throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'health failed'); }
        return { checks: [{ name: 'mcp:read', ok: true }] };
      }
    }
    const adapter = new BlockingAdapter();
    const { service } = await setup(adapter);
    const first = service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' });
    await entered;
    const second = service.deploy({ projectId: 'project-1', revisionId: 'rev-2', environment: 'production', idempotencyKey: 'request-2', expectedActiveProviderRevisionId: 'provider-old' });
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
        this.active = { providerDeploymentId: 'dep-other', providerRevisionId: 'provider-other', projectId: 'project-1', revisionId: 'rev-other', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://other.test' };
        throw new CynderDeploymentError(502, 'FOLDY_CYNDER_HEALTH_FAILED', 'health failed');
      }
    }
    const adapter = new ChangedActiveAdapter(); const { service } = await setup(adapter);
    await expect(service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'request-1', expectedActiveProviderRevisionId: 'provider-old' }))
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
    })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED', rollbackFailed: true });
    expect(adapter.rollbackInputs[0]?.expectedActiveProviderRevisionId).toBe('provider-new');
    expect(adapter.active?.providerRevisionId).toBe('provider-external');
  });

  it('durably stages the exact restore binding and records rollback as rolled_back', async () => {
    const { service, adapter, dataRoot } = await setup();
    const deployed = await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'deploy-target', expectedActiveProviderRevisionId: 'provider-old' });
    adapter.active = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-current', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test' };
    adapter.rollback = async (input) => {
      adapter.calls.push('rollback');
      const files = await import('node:fs/promises').then((fs) => fs.readdir(path.join(dataRoot, 'foldy-deployments', 'staged')));
      const staged = JSON.parse(await readFile(path.join(dataRoot, 'foldy-deployments', 'staged', files[0]!), 'utf8'));
      expect(staged.binding).toEqual(input.restore);
      adapter.active = input.restore;
    };
    const receipt = await service.rollback({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'rollback-target', expectedActiveProviderRevisionId: 'provider-current' });
    expect(receipt.status).toBe('rolled_back');
    expect(receipt.binding).toEqual(deployed.binding);
  });

  it('reconciles and health-checks an exact staged rollback after restart', async () => {
    const { service, adapter, dataRoot } = await setup();
    await service.deploy({ projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'deploy-target', expectedActiveProviderRevisionId: 'provider-old' });
    adapter.active = { providerDeploymentId: 'dep-current', providerRevisionId: 'provider-current', projectId: 'project-1', revisionId: 'rev-current', bundleSha256: 'e'.repeat(64), environment: 'production', url: 'https://current.test' };
    const input = { projectId: 'project-1', revisionId: 'rev-1', environment: 'production', idempotencyKey: 'rollback-target', expectedActiveProviderRevisionId: 'provider-current' } as const;
    const completed = await service.rollback(input);
    const finalPath = path.join(dataRoot, 'foldy-deployments', 'receipts', `${completed.receiptId}.json`);
    await rm(finalPath);
    const stagedPath = path.join(dataRoot, 'foldy-deployments', 'staged', `${sha(`${input.projectId}\0${input.environment}\0${input.idempotencyKey}`)}.json`);
    await writeFile(stagedPath, JSON.stringify({ ...completed, status: 'staged', health: null, completedAt: null }));
    adapter.calls.length = 0;
    const restarted = new FoldyCynderDeploymentService({ dataRoot, adapter, getRevision: async () => revision, readRevisionFile: async () => Buffer.from('unused') });
    const reconciled = await restarted.rollback(input);
    expect(reconciled.status).toBe('rolled_back');
    expect(reconciled.binding).toEqual(completed.binding);
    expect(adapter.calls).toEqual(['inspect', 'health']);
  });

  it.each([
    'https://user@deploy.example',
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
    const binding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url };
    await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_BINDING_URL_REJECTED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a malicious immutable deployment binding before it can be activated', async () => {
    const binding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'https://127.0.0.1' };
    const fetcher = vi.fn(async () => Response.json(binding));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['127.0.0.1'], fetch: fetcher });
    await expect(adapter.deployImmutable({ projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', idempotencyKey: 'receipt-1', entryFile: 'index.html', files: [] }))
      .rejects.toMatchObject({ code: 'FOLDY_CYNDER_BINDING_URL_REJECTED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('permits HTTP only for an explicitly configured public deployment host', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 500 }));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['deploy.example'], allowHttpDeploymentHosts: ['deploy.example'], fetch: fetcher });
    const binding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'http://deploy.example' };
    await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });
    expect(fetcher).toHaveBeenCalledWith('http://deploy.example/', expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects redirect responses and disables redirects for every health fetch', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1' } }));
    const adapter = new HttpCynderDeploymentAdapter({ endpoint: 'https://provider.example', secretEnv: 'PATH', deploymentHosts: ['deploy.example'], fetch: fetcher });
    const binding = { providerDeploymentId: 'dep', providerRevisionId: 'provider-rev', projectId: 'project-1', revisionId: 'rev-1', bundleSha256: 'a'.repeat(64), environment: 'production', url: 'https://deploy.example' };
    await expect(adapter.verifyHealth({ binding, entryFile: 'index.html', declaredRoutes: [] })).rejects.toMatchObject({ code: 'FOLDY_CYNDER_HEALTH_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://deploy.example/', expect.objectContaining({ redirect: 'error' }));
  });
});
