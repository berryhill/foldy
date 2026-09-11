import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    expect(store.list()).not.toHaveProperty('tokenSha256');
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
  });

  it('validates scopes and deduplicates them', async () => {
    const { store } = await fixture();
    const issued = await store.create({ projectId: 'p', scopes: ['publisher', 'publisher', 'read'] });
    expect(issued.grant.scopes).toEqual(['read', 'publisher']);
    await expect(store.create({ projectId: 'p', scopes: [] })).rejects.toThrow(/scope/i);
  });
});
