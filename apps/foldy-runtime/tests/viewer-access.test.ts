import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';
const { argon2Sync } = crypto as unknown as { argon2Sync: (algorithm: 'argon2id', options: { message: Buffer; nonce: Buffer; memory: number; passes: number; parallelism: number; tagLength: number }) => Buffer };
import { ViewerAccess } from '../src/viewer-access.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'foldy-viewer-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1000000;
  let cacheOK = true;
  const owner = {};
  const options = { directory: join(root, 'custody'), instanceId: 'instance-a', workbookId: 'workbook-a', clock: () => now,
    authorizeOwner: async (context: unknown) => context === owner ? { actorRef: 'owner-a' } : null,
    invalidateCaches: async () => cacheOK,
    allowSource: async () => true };
  const access = new ViewerAccess(options);
  const password = randomBytes(24).toString('base64url');
  return { root, options, access, owner, password, advance: (ms: number) => { now += ms; }, failCache: () => { cacheOK = false; } };
}

test('public default; real Argon2id unique salt; exact Unicode; protected custody and redacted receipt', async t => {
  const f = fixture(t);
  assert.equal((await f.access.authorize(undefined)).allowed, true);
  const password = ' ' + String.fromCodePoint(0x1f642).repeat(11);
  const receipt = await f.access.configure(f.owner, { mode: 'password_required', password });
  const state = JSON.parse(readFileSync(join(f.options.directory, 'viewer-access.json'), 'utf8'));
  assert.equal(state.verifier.algorithm, 'argon2id');
  const actual = argon2Sync('argon2id', { message: Buffer.from(password, 'utf8'), nonce: Buffer.from(state.verifier.salt, 'hex'), memory: 65536, passes: 3, parallelism: 1, tagLength: 32 });
  assert.ok(actual.equals(Buffer.from(state.verifier.hash, 'hex')));
  assert.equal(statSync(join(f.options.directory, 'viewer-access.json')).mode & 0o777, 0o600);
  assert.equal(statSync(f.options.directory).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(receipt).includes(state.verifier.hash), false);
  assert.equal((await f.access.unlock(password.trim(), 'source')).ok, false);
  assert.equal((await f.access.unlock(password, 'source')).ok, true);
  await f.access.configure(f.owner, { mode: 'password_required', password });
  const next = JSON.parse(readFileSync(join(f.options.directory, 'viewer-access.json'), 'utf8'));
  assert.notEqual(next.verifier.salt, state.verifier.salt);
  for (const invalid of ['x'.repeat(11), 'x'.repeat(129), '\ud800'.repeat(12)]) {
    await assert.rejects(f.access.configure(f.owner, { mode: 'password_required', password: invalid }), /PASSWORD_POLICY/);
  }
});

test('restart persists session hash, logout rejects replay, identity and privilege boundaries', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  const login = await f.access.unlock(f.password, 'source');
  assert.ok(login.ok); if (!login.ok) return;
  assert.equal(readFileSync(join(f.options.directory, 'viewer-access.json'), 'utf8').includes(login.token), false);
  const restarted = new ViewerAccess(f.options);
  assert.deepEqual(await restarted.authorize(login.token), { allowed: true, role: 'VIEWER' });
  assert.equal((await restarted.authorize(login.token, 'owner')).allowed, false);
  assert.equal((await restarted.authorize(login.token, 'mcp')).allowed, false);
  await assert.rejects(restarted.configure(login.token, { mode: 'public', confirmDisable: true }), /OWNER_REQUIRED/);
  assert.equal((await new ViewerAccess({ ...f.options, instanceId: 'other' }).authorize(login.token)).allowed, false);
  assert.equal((await new ViewerAccess({ ...f.options, workbookId: 'other' }).authorize(login.token)).allowed, false);
  await restarted.logout(login.token);
  assert.equal((await new ViewerAccess(f.options).authorize(login.token)).allowed, false);
});

test('idle and absolute expiry use injected clock and cannot be refreshed past absolute expiry', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  let login = await f.access.unlock(f.password, 'source'); assert.ok(login.ok); if (!login.ok) return;
  f.advance(30 * 60000);
  assert.equal((await f.access.authorize(login.token)).allowed, false);
  login = await f.access.unlock(f.password, 'source'); assert.ok(login.ok); if (!login.ok) return;
  for (let i = 0; i < 35; i++) { f.advance(20 * 60000); assert.equal((await f.access.authorize(login.token)).allowed, true); }
  f.advance(20 * 60000);
  assert.equal((await f.access.authorize(login.token)).allowed, false);
});

test('rotation and disable revoke all grants, old password fails, reenable does not revive grants', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  const a = await f.access.unlock(f.password, 'a'); const b = await f.access.unlock(f.password, 'b');
  assert.ok(a.ok && b.ok); if (!a.ok || !b.ok) return;
  const replacement = randomBytes(24).toString('hex');
  await f.access.configure(f.owner, { mode: 'password_required', password: replacement });
  assert.equal((await f.access.authorize(a.token)).allowed, false);
  assert.equal((await f.access.authorize(b.token)).allowed, false);
  assert.equal((await f.access.unlock(f.password, 'a')).ok, false);
  await assert.rejects(f.access.configure(f.owner, { mode: 'public' }), /CONFIRM_REQUIRED/);
  await f.access.configure(f.owner, { mode: 'public', confirmDisable: true });
  assert.equal((await f.access.authorize()).allowed, true);
  assert.equal(JSON.parse(readFileSync(join(f.options.directory, 'viewer-access.json'), 'utf8')).verifier, null);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  assert.equal((await f.access.authorize(a.token)).allowed, false);
});

test('five failures trigger persistent source-only exponential throttling', async t => {
  const f = fixture(t); await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  const wrong = randomBytes(24).toString('hex');
  for (let i = 0; i < 5; i++) assert.equal((await f.access.unlock(wrong, 'bad')).ok, false);
  assert.equal((await new ViewerAccess(f.options).unlock(f.password, 'bad')).code, 'RATE_LIMITED');
  assert.equal((await f.access.unlock(f.password, 'good')).ok, true);
  f.advance(1000);
  const sixth = await f.access.unlock(wrong, 'bad'); assert.equal(sixth.retryAfterMs, 2000);
  f.advance(15 * 60000);
  assert.equal((await f.access.unlock(f.password, 'bad')).ok, true);
});

test('pending cache invalidation and competing writers fail closed; broader limiter enforced', async t => {
  const f = fixture(t);
  let release!: (value: boolean) => void;
  let reached!: () => void;
  const entered = new Promise<void>(r => { reached = r; });
  const gate = new Promise<boolean>(r => { release = r; });
  const a = new ViewerAccess({ ...f.options, invalidateCaches: async () => { reached(); return gate; } });
  const pending = a.configure(f.owner, { mode: 'password_required', password: f.password });
  await entered;
  assert.equal((await f.access.authorize()).allowed, false);
  await assert.rejects(f.access.configure(f.owner, { mode: 'public', confirmDisable: true }), /STORE_UNAVAILABLE/);
  release(true); await pending;
  const limited = new ViewerAccess({ ...f.options, allowSource: async () => false });
  assert.equal((await limited.unlock(f.password, 'source')).code, 'RATE_LIMITED');
  assert.deepEqual(await limited.status(), { mode: 'password_required', protectionVersion: 1 });
  const exact = String.fromCodePoint(0xe9).repeat(128);
  await f.access.configure(f.owner, { mode: 'password_required', password: exact });
  assert.equal((await f.access.unlock(exact.normalize('NFD'), 'source')).ok, false);
  assert.equal((await f.access.unlock(exact, 'source')).ok, true);
});

test('failed-only traffic prunes expired sources and sessions before persistence', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  assert.ok((await f.access.unlock(f.password, 'viewer')).ok);
  for (let i = 0; i < 12; i++) {
    f.advance(31 * 60000);
    assert.equal((await f.access.unlock('short', `source-${i}`)).code, 'AUTH_INVALID');
    const state = JSON.parse(readFileSync(join(f.options.directory, 'viewer-access.json'), 'utf8'));
    assert.equal(Object.keys(state.failures).length, 1);
    assert.equal(Object.keys(state.sessions).length, 0);
  }
});

test('active capacity rejects admissions without evicting throttles or existing viewers; owner recovers', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  const viewer = await f.access.unlock(f.password, 'viewer'); assert.ok(viewer.ok); if (!viewer.ok) return;
  for (let i = 0; i < 1024; i++) await f.access.unlock('short', `source-${i}`);
  const file = join(f.options.directory, 'viewer-access.json');
  const before = readFileSync(file, 'utf8');
  assert.equal((await new ViewerAccess(f.options).unlock('short', 'overflow')).code, 'RATE_LIMITED');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal((await f.access.authorize(viewer.token)).allowed, true);
  await f.access.configure(f.owner, { mode: 'public', confirmDisable: true });
  assert.equal((await new ViewerAccess(f.options).authorize()).allowed, true);
  assert.equal(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).failures) === JSON.stringify(JSON.parse(before).failures), true);
});

test('anonymous Argon2 does not lock out current viewers or owner rotation', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  const viewer = await f.access.unlock(f.password, 'viewer'); assert.ok(viewer.ok); if (!viewer.ok) return;
  let settled = false;
  const pending = f.access.unlock(f.password, 'racer').finally(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    assert.equal(settled, false, 'exercise an in-flight real Argon2 derivation');
    assert.equal((await new ViewerAccess(f.options).authorize(viewer.token)).allowed, true);
    await f.access.configure(f.owner, { mode: 'public', confirmDisable: true });
    assert.equal((await pending).ok, false, 'a pre-rotation verifier cannot issue a post-rotation grant');
    const state = JSON.parse(readFileSync(join(f.options.directory, 'viewer-access.json'), 'utf8'));
    assert.equal(Object.keys(state.sessions).length, 0);
  } finally { await pending; }
});

test('session capacity and serialized-byte limits reject only new grants', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  const viewer = await f.access.unlock(f.password, 'viewer'); assert.ok(viewer.ok); if (!viewer.ok) return;
  const file = join(f.options.directory, 'viewer-access.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const session = Object.values(state.sessions)[0];
  for (let i = 0; i < 1023; i++) state.sessions[crypto.createHash('sha256').update(`fixture-${i}`).digest('hex')] = session;
  writeFileSync(file, JSON.stringify(state));
  assert.equal((await f.access.unlock(f.password, 'new-viewer')).code, 'RATE_LIMITED');
  assert.equal((await new ViewerAccess(f.options).authorize(viewer.token)).allowed, true);
  assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions).length, 1024);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  assert.ok((await f.access.unlock(f.password, 'new-viewer')).ok);

  const large = new ViewerAccess({ ...f.options, directory: join(f.root, 'large'), instanceId: 'i'.repeat(4 * 1024 * 1024) });
  await large.configure(f.owner, { mode: 'password_required', password: f.password });
  assert.equal((await large.unlock(f.password, 'source')).code, 'RATE_LIMITED');
  assert.ok(statSync(join(f.root, 'large', 'viewer-access.json')).size < 8 * 1024 * 1024);
  assert.equal((await large.status()).mode, 'password_required');
  await large.configure(f.owner, { mode: 'public', confirmDisable: true });
  assert.equal((await large.authorize()).allowed, true);
});

test('anonymous derivations are bounded across instances with an independent owner lane', async t => {
  const f = fixture(t);
  await f.access.configure(f.owner, { mode: 'password_required', password: f.password });
  const pending: Promise<unknown>[] = [];
  // Advance admission promises without yielding to native Argon2 completion
  // callbacks. A macrotask yield can finish the first derivation on busy hosts.
  const admit = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
  try {
    pending.push(f.access.unlock(f.password, 'first'));
    await admit();
    pending.push(new ViewerAccess(f.options).unlock(f.password, 'second'));
    await admit();
    assert.equal((await new ViewerAccess(f.options).unlock(f.password, 'third')).code, 'RATE_LIMITED');
    await f.access.configure(f.owner, { mode: 'password_required', password: randomBytes(24).toString('hex') });
    assert.equal((await f.access.status()).protectionVersion, 2);
  } finally { await Promise.all(pending); }
});

test('bad/missing/symlink state and cache failure fail closed across restart', async t => {
  const f = fixture(t); f.failCache();
  await assert.rejects(f.access.configure(f.owner, { mode: 'password_required', password: f.password }), /CACHE_UNAVAILABLE/);
  assert.equal((await new ViewerAccess(f.options).authorize()).allowed, false);
  const file = join(f.options.directory, 'viewer-access.json');
  writeFileSync(file, '{}'); assert.equal((await f.access.authorize()).allowed, false);
  unlinkSync(file); assert.equal((await new ViewerAccess(f.options).authorize()).allowed, false);
  const target = join(f.root, 'target'); writeFileSync(target, '{}', { mode: 0o600 }); symlinkSync(target, file);
  assert.equal((await f.access.authorize()).allowed, false);
  const linked = join(f.root, 'linked'); symlinkSync(f.options.directory, linked);
  assert.throws(() => new ViewerAccess({ ...f.options, directory: linked }), /STORE_UNAVAILABLE/);
});
