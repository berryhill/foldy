import type http from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBrowserPasswordAccess,
  installBrowserPasswordGate,
  registerBrowserPasswordAccessRoutes,
} from '../../src/foldy-access/browser-password.js';

const PASSWORD = 'correct horse battery staple';
const ROTATED_PASSWORD = 'different shared password';
const SENTINEL = 'PROTECTED_SENTINEL_7f39';
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

interface Fixture {
  baseUrl: string;
  dataRoot: string;
  close(): Promise<void>;
}

async function fixture(options: { dataRoot?: string; now?: () => number } = {}): Promise<Fixture> {
  const dataRoot = options.dataRoot ?? await mkdtemp(path.join(os.tmpdir(), 'foldy-access-'));
  const access = await createBrowserPasswordAccess({
    dataRoot,
    ...(options.now ? { now: options.now } : {}),
  });
  const app = express();
  app.use(express.json());

  registerBrowserPasswordAccessRoutes(app, access);
  app.use(installBrowserPasswordGate(access));
  // Only Foldy's exact bearer transport is outside browser-session authority.
  app.get('/api/foldy/mcp/session', (req, res) => {
    if (req.get('authorization') !== 'Bearer mcp-test-token') {
      res.status(401).json({ error: { code: 'MCP_BEARER_REQUIRED' } });
      return;
    }
    res.send(SENTINEL);
  });
  app.get('/api/mcp/sentinel', (_req, res) => res.send(SENTINEL));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/version', (_req, res) => res.json({ version: 'test' }));
  app.get('/', (_req, res) => res.type('html').send(`<main>${SENTINEL}</main>`));
  app.get('/assets/app.js', (_req, res) => res.type('js').send(`window.value='${SENTINEL}'`));
  app.get('/api/private', (_req, res) => res.json({ value: SENTINEL }));
  app.get('/api/projects/p1/raw/index.html', (_req, res) => res.send(SENTINEL));
  app.get('/p/p1/index.html', (_req, res) => res.send(SENTINEL));

  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  cleanup.push(async () => {
    await close();
    if (!options.dataRoot) await rm(dataRoot, { recursive: true, force: true });
  });
  return { baseUrl, dataRoot, close };
}

function origin(f: Fixture): Record<string, string> {
  return { origin: f.baseUrl, 'content-type': 'application/json' };
}

async function configure(f: Fixture, password = PASSWORD, cookie?: string): Promise<Response> {
  return fetch(`${f.baseUrl}/api/foldy-access/password`, {
    method: 'PUT',
    headers: { ...origin(f), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ password }),
  });
}

async function unlock(f: Fixture, password = PASSWORD): Promise<{ response: Response; cookie: string }> {
  const response = await fetch(`${f.baseUrl}/api/foldy-access/unlock`, {
    method: 'POST',
    headers: origin(f),
    body: JSON.stringify({ password }),
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? '' };
}

describe('opt-in shared browser password gate', () => {
  it('passes every surface through while disabled and leaves health/version open when enabled', async () => {
    const f = await fixture();
    for (const pathname of ['/', '/assets/app.js', '/api/private', '/api/projects/p1/raw/index.html', '/p/p1/index.html']) {
      const response = await fetch(`${f.baseUrl}${pathname}`);
      expect(response.status, pathname).toBe(200);
      expect(await response.text(), pathname).toContain(SENTINEL);
    }
    const status = await fetch(`${f.baseUrl}/api/foldy-access/status`);
    await expect(status.json()).resolves.toEqual({ enabled: false, authenticated: false });

    expect((await configure(f)).status).toBe(204);
    expect((await fetch(`${f.baseUrl}/api/health`)).status).toBe(200);
    expect((await fetch(`${f.baseUrl}/api/version`)).status).toBe(200);
  });

  it('denies HTML, static, browser API, project, and publication bytes before any sentinel leaks', async () => {
    const f = await fixture();
    expect((await configure(f)).status).toBe(204);
    for (const pathname of ['/', '/assets/app.js', '/api/private', '/api/projects/p1/raw/index.html', '/p/p1/index.html']) {
      const response = await fetch(`${f.baseUrl}${pathname}`);
      const body = await response.text();
      expect(response.status, pathname).toBe(401);
      expect(body, pathname).not.toContain(SENTINEL);
      expect(response.headers.get('cache-control'), pathname).toBe('no-store');
    }
  });

  it('renders a human-usable unlock page for protected browser navigation while APIs keep JSON errors', async () => {
    const f = await fixture();
    await configure(f);

    const navigation = await fetch(`${f.baseUrl}/p/p1/index.html`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(navigation.status).toBe(401);
    expect(navigation.headers.get('content-type')).toContain('text/html');
    const page = await navigation.text();
    expect(page).toContain('<form');
    expect(page).toContain('/api/foldy-access/unlock');
    expect(page).not.toContain(SENTINEL);

    const api = await fetch(`${f.baseUrl}/api/private`, { headers: { accept: 'text/html' } });
    expect(api.status).toBe(401);
    expect(api.headers.get('content-type')).toContain('application/json');
    await expect(api.json()).resolves.toMatchObject({
      error: { code: 'FOLDY_ACCESS_AUTHENTICATION_REQUIRED' },
    });
  });

  it('unlocks with a bounded strict cookie, reports status, and logout clears only the caller authority', async () => {
    const f = await fixture();
    await configure(f);
    const { response, cookie } = await unlock(f);
    expect(response.status).toBe(204);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toBe('');

    const protectedResponse = await fetch(`${f.baseUrl}/api/private`, { headers: { cookie } });
    expect(protectedResponse.status).toBe(200);
    expect(await protectedResponse.text()).toContain(SENTINEL);
    const status = await fetch(`${f.baseUrl}/api/foldy-access/status`, { headers: { cookie } });
    await expect(status.json()).resolves.toEqual({ enabled: true, authenticated: true });

    const second = await unlock(f);
    expect(second.response.status).toBe(204);
    const unauthenticatedLogout = await fetch(`${f.baseUrl}/api/foldy-access/logout`, {
      method: 'POST', headers: origin(f),
    });
    expect(unauthenticatedLogout.status).toBe(401);
    const logout = await fetch(`${f.baseUrl}/api/foldy-access/logout`, {
      method: 'POST', headers: { ...origin(f), cookie },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${f.baseUrl}/api/private`, { headers: { cookie: second.cookie } })).status).toBe(200);
    // Logout expires only the caller's browser-held cookie; it does not keep a
    // global revocation list or invalidate either independently issued token.
    expect((await fetch(`${f.baseUrl}/api/private`, { headers: { cookie } })).status).toBe(200);
  });

  it('rejects a correctly signed session after its bounded expiry', async () => {
    let now = 2_000_000;
    const f = await fixture({ now: () => now });
    await configure(f);
    const session = await unlock(f);
    expect(session.response.status).toBe(204);
    expect((await fetch(`${f.baseUrl}/api/private`, { headers: { cookie: session.cookie } })).status).toBe(200);
    now += 12 * 60 * 60 * 1000 + 1;
    expect((await fetch(`${f.baseUrl}/api/private`, { headers: { cookie: session.cookie } })).status).toBe(401);
  });

  it('throttles repeated wrong passwords without logging or returning either password', async () => {
    let now = 1_000_000;
    const f = await fixture({ now: () => now });
    await configure(f);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await unlock(f, `wrong password ${attempt}`);
      expect(wrong.response.status).toBe(401);
      expect(await wrong.response.text()).not.toContain(`wrong password ${attempt}`);
    }
    const throttled = await unlock(f, 'wrong password 5');
    expect(throttled.response.status).toBe(429);
    expect(Number(throttled.response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await unlock(f)).response.status).toBe(429);
    now += 61_000;
    expect((await unlock(f)).response.status).toBe(204);
  });

  it('rotation and disable revoke old sessions and require current session authority', async () => {
    const f = await fixture();
    await configure(f);
    const oldSession = await unlock(f);
    expect(oldSession.response.status).toBe(204);

    const unauthenticatedRotation = await configure(f, ROTATED_PASSWORD);
    expect(unauthenticatedRotation.status).toBe(401);
    const rotated = await configure(f, ROTATED_PASSWORD, oldSession.cookie);
    expect(rotated.status).toBe(204);
    expect((await fetch(`${f.baseUrl}/api/private`, { headers: { cookie: oldSession.cookie } })).status).toBe(401);
    expect((await unlock(f, PASSWORD)).response.status).toBe(401);
    const current = await unlock(f, ROTATED_PASSWORD);
    expect(current.response.status).toBe(204);

    const disabled = await fetch(`${f.baseUrl}/api/foldy-access/password`, {
      method: 'DELETE', headers: { ...origin(f), cookie: current.cookie },
    });
    expect(disabled.status).toBe(204);
    expect((await fetch(`${f.baseUrl}/api/private`)).status).toBe(200);
    expect((await configure(f, PASSWORD)).status).toBe(204);
    expect((await fetch(`${f.baseUrl}/api/private`, { headers: { cookie: current.cookie } })).status).toBe(401);
  });

  it('persists only verifier/session material and preserves sessions across restart', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'foldy-access-restart-'));
    cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
    const first = await fixture({ dataRoot });
    await configure(first);
    const session = await unlock(first);
    expect(session.response.status).toBe(204);
    await first.close();

    const persisted = await readFile(path.join(dataRoot, 'foldy-access', 'browser-password.json'), 'utf8');
    if (process.platform !== 'win32') {
      expect((await stat(path.join(dataRoot, 'foldy-access', 'browser-password.json'))).mode & 0o777).toBe(0o600);
    }
    expect(persisted).not.toContain(PASSWORD);
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: 1,
      enabled: true,
      scrypt: { N: expect.any(Number), r: expect.any(Number), p: expect.any(Number), keyLength: expect.any(Number) },
      salt: expect.any(String),
      passwordHash: expect.any(String),
      sessionKey: expect.any(String),
    });

    const second = await fixture({ dataRoot });
    expect((await fetch(`${second.baseUrl}/api/private`, { headers: { cookie: session.cookie } })).status).toBe(200);
  });

  it('exempts only the exact Foldy bearer transport, never generic MCP APIs', async () => {
    const f = await fixture();
    await configure(f);
    const session = await unlock(f);
    expect(session.response.status).toBe(204);
    expect((await fetch(`${f.baseUrl}/api/mcp/sentinel`)).status).toBe(401);
    expect((await fetch(`${f.baseUrl}/api/mcp/sentinel`, { headers: { authorization: 'Bearer mcp-test-token' } })).status).toBe(401);
    const bearer = await fetch(`${f.baseUrl}/api/foldy/mcp/session`, {
      headers: { authorization: 'Bearer mcp-test-token' },
    });
    expect(bearer.status).toBe(200);
  });

  it('rejects cross-origin administration and remote plaintext password submission', async () => {
    const f = await fixture();
    const crossOrigin = await fetch(`${f.baseUrl}/api/foldy-access/password`, {
      method: 'PUT',
      headers: { origin: 'http://attacker.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(crossOrigin.status).toBe(403);

    const access = await createBrowserPasswordAccess({ dataRoot: f.dataRoot });
    const app = express();
    app.use(express.json());
    registerBrowserPasswordAccessRoutes(app, access);
    const handler = app as unknown as (req: express.Request, res: express.Response) => void;
    const req = {
      method: 'POST', url: '/api/foldy-access/unlock', originalUrl: '/api/foldy-access/unlock',
      headers: { host: 'example.test', origin: 'http://example.test', 'content-type': 'application/json' },
      socket: { remoteAddress: '203.0.113.7' }, connection: { remoteAddress: '203.0.113.7' },
    } as unknown as express.Request;
    expect(handler).toBeTypeOf('function');
    // The concrete remote transport branch is also exported for proxy/server adapters.
    expect(access.acceptsPasswordTransport(req)).toBe(false);
  });
});
