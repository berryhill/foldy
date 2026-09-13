import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFoldyMcpGrantStore } from '../../src/foldy-mcp/grants.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foldy-mcp-grants-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, store: await createFoldyMcpGrantStore({ dataRoot: root, randomToken: () => 'one-time-secret', randomId: () => 'grant-1' }) };
}

describe('Foldy MCP grant store', () => {
  it('binds independent scopes to exactly one project and persists only the token hash', async () => {
    const { root, store } = await fixture();
    const issued = await store.create({ projectId: 'project-a', scopes: ['read', 'reviewer'] });
    expect(issued.token).toBe('one-time-secret');
    expect(issued.grant).toMatchObject({ grantId: 'grant-1', projectId: 'project-a', scopes: ['read', 'reviewer'], revokedAt: null });
    const persisted = await readFile(path.join(root, 'foldy-mcp', 'grants.json'), 'utf8');
    expect(persisted).not.toContain('one-time-secret');
    expect(JSON.parse(persisted).grants[0].tokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(store.list()[0]).not.toHaveProperty('tokenSha256');
  });

  it('survives restart, rejects cross-project use, and denies immediately after revocation', async () => {
    const { root, store } = await fixture();
    await store.create({ projectId: 'project-a', scopes: ['editor'] });
    const restarted = await createFoldyMcpGrantStore({ dataRoot: root });
    expect(restarted.authenticate('one-time-secret', 'project-a', 'editor')?.projectId).toBe('project-a');
    expect(restarted.authenticate('one-time-secret', 'project-b', 'editor')).toBeNull();
    expect(restarted.authenticate('one-time-secret', 'project-a', 'read')).toBeNull();
    await restarted.revoke('grant-1');
    expect(restarted.authenticate('one-time-secret', 'project-a', 'editor')).toBeNull();
    expect(restarted.deploymentDescriptor('grant-1', 'project-a')).toBeNull();
    expect(restarted.pendingRevocations()).toEqual([expect.objectContaining({
      grantId: 'grant-1', projectId: 'project-a', status: 'pending', attempts: 0,
      tokenSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    const afterRestart = await createFoldyMcpGrantStore({ dataRoot: root });
    expect(afterRestart.authenticate('one-time-secret', 'project-a', 'editor')).toBeNull();
    expect(afterRestart.pendingRevocations()).toHaveLength(1);
  });

  it('validates scopes and deduplicates them', async () => {
    const { store } = await fixture();
    const issued = await store.create({ projectId: 'p', scopes: ['publisher', 'publisher', 'read'] });
    expect(issued.grant.scopes).toEqual(['read', 'publisher']);
    await expect(store.create({ projectId: 'p', scopes: [] })).rejects.toThrow(/scope/i);
  });

  it('exposes only an active, project-bound deployment descriptor', async () => {
    const { store } = await fixture();
    await store.create({ projectId: 'project-a', scopes: ['read', 'deployer'] });

    const descriptor = store.deploymentDescriptor('grant-1', 'project-a');
    expect(descriptor).toEqual({
      grantId: 'grant-1',
      scopes: ['read', 'deployer'],
      tokenSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(descriptor && store.isCurrentDeploymentDescriptor('project-a', descriptor)).toBe(true);
    expect(descriptor && store.isCurrentDeploymentDescriptor('project-b', descriptor)).toBe(false);
    expect(descriptor && store.isCurrentDeploymentDescriptor('project-a', { ...descriptor, tokenSha256: '0'.repeat(64) })).toBe(false);
    expect(descriptor && store.isCurrentDeploymentDescriptor('project-a', { ...descriptor, scopes: ['deployer', 'read'] })).toBe(false);
    expect(store.deploymentDescriptor('grant-1', 'project-b')).toBeNull();
    await store.revoke('grant-1');
    expect(store.deploymentDescriptor('grant-1', 'project-a')).toBeNull();
    expect(descriptor && store.isCurrentDeploymentDescriptor('project-a', descriptor)).toBe(false);
  });

  it('migrates v1 state and creates a durable pending intent for an already revoked grant', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'foldy-mcp-v1-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'foldy-mcp');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'grants.json'), JSON.stringify({
      schemaVersion: 1,
      grants: [{
        grantId: 'legacy', projectId: 'project-a', scopes: ['read'],
        createdAt: '2026-09-01T00:00:00.000Z', revokedAt: '2026-09-02T00:00:00.000Z',
        tokenSha256: 'a'.repeat(64),
      }],
    }));

    const store = await createFoldyMcpGrantStore({ dataRoot: root });
    expect(store.get('legacy')).toMatchObject({ revocationStatus: 'pending' });
    expect(store.pendingRevocations()).toEqual([expect.objectContaining({ grantId: 'legacy', attempts: 0 })]);
    const persisted = JSON.parse(await readFile(path.join(directory, 'grants.json'), 'utf8'));
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.remoteRevocations).toHaveLength(1);
  });

  it('keeps authoritative create and revoke state unchanged when persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'foldy-mcp-cow-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let fail = true;
    const store = await createFoldyMcpGrantStore({
      dataRoot: root, randomToken: () => 'cow-secret', randomId: () => 'cow-grant',
      persistState: async (persist) => { if (fail) throw Object.assign(new Error('write failed'), { code: 'EIO' }); await persist(); },
    });
    await expect(store.create({ projectId: 'project-a', scopes: ['read'] })).rejects.toThrow('write failed');
    expect(store.list()).toEqual([]);
    fail = false;
    await store.create({ projectId: 'project-a', scopes: ['read'] });
    expect(store.authenticate('cow-secret', 'project-a', 'read')).not.toBeNull();
    fail = true;
    await expect(store.revoke('cow-grant')).rejects.toThrow('write failed');
    expect(store.authenticate('cow-secret', 'project-a', 'read')).not.toBeNull();
    expect(store.pendingRevocations()).toEqual([]);
    fail = false;
    await store.revoke('cow-grant');
    expect(store.authenticate('cow-secret', 'project-a', 'read')).toBeNull();
  });

  it('durably records retry attempts and does not return completed intents as pending', async () => {
    const { root, store } = await fixture();
    await store.create({ projectId: 'project-a', scopes: ['read'] });
    await store.revoke('grant-1');
    await store.recordRevocationAttempt('grant-1', { status: 'pending', errorCode: 'PROVIDER_UNAVAILABLE' });
    expect(store.pendingRevocations()[0]).toMatchObject({ attempts: 1, lastErrorCode: 'PROVIDER_UNAVAILABLE' });
    await store.recordRevocationAttempt('grant-1', { status: 'complete' });
    expect(store.pendingRevocations()).toEqual([]);
    expect(store.get('grant-1')).toMatchObject({ revocationStatus: 'complete' });
    const restarted = await createFoldyMcpGrantStore({ dataRoot: root });
    expect(restarted.get('grant-1')).toMatchObject({ revocationStatus: 'complete' });
  });
});
