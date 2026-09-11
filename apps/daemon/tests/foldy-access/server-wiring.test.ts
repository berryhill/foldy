import type http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_PASSWORD = 'server wiring password';

interface StartedServer {
  url: string;
  server: http.Server;
  shutdown?: () => Promise<void> | void;
}

describe('Foldy browser password real daemon wiring', () => {
  let started: StartedServer;
  let dataRoot: string;
  const originalDataDir = process.env.OD_DATA_DIR;

  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'foldy-access-server-'));
    process.env.OD_DATA_DIR = dataRoot;
    vi.resetModules();
    const { startServer } = await import('../../src/server.js') as {
      startServer(options: { port: number; returnServer: true }): Promise<StartedServer>;
    };
    started = await startServer({ port: 0, returnServer: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.resolve(started.shutdown?.());
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
    await rm(dataRoot, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.OD_DATA_DIR;
    else process.env.OD_DATA_DIR = originalDataDir;
    vi.resetModules();
  });

  it('installs bootstrap routes before the gate and the gate before real project/publication APIs', async () => {
    const initial = await fetch(`${started.url}/api/projects`);
    expect(initial.status).toBe(200);

    const configured = await fetch(`${started.url}/api/foldy-access/password`, {
      method: 'PUT',
      headers: { origin: started.url, 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(configured.status).toBe(204);

    for (const pathname of ['/api/projects', '/api/projects/not-present/publication', '/api/projects/not-present/raw/index.html']) {
      const denied = await fetch(`${started.url}${pathname}`);
      expect(denied.status, pathname).toBe(401);
      expect(await denied.text(), pathname).not.toContain('not-present');
    }
    expect((await fetch(`${started.url}/api/health`)).status).toBe(200);
    expect((await fetch(`${started.url}/api/version`)).status).toBe(200);

    const oversizedProtected = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(5 * 1024 * 1024) }),
    });
    expect(oversizedProtected.status).toBe(401);
    const oversizedBootstrap = await fetch(`${started.url}/api/foldy-access/unlock`, {
      method: 'POST', headers: { origin: started.url, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(3 * 1024) }),
    });
    expect(oversizedBootstrap.status).toBe(413);

    const unlocked = await fetch(`${started.url}/api/foldy-access/unlock`, {
      method: 'POST',
      headers: { origin: started.url, 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(unlocked.status).toBe(204);
    const cookie = unlocked.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    expect((await fetch(`${started.url}/api/projects`, { headers: { cookie: cookie! } })).status).toBe(200);
  });
});
