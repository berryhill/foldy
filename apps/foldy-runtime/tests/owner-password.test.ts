import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { deriveOwnerPassword, validateOwnerPassword, verifyOwnerPassword } from '../dist/owner-password.js';

const { argon2Sync } = crypto as unknown as { argon2Sync: (algorithm: 'argon2id', options: { message: Buffer; nonce: Buffer; memory: number; passes: number; parallelism: number; tagLength: number }) => Buffer };
const synthetic = () => randomBytes(24).toString('base64url');

test('validates exact Unicode scalar input without trimming or normalization', async () => {
  const unicode = ' ' + '🙂'.repeat(11);
  assert.equal(validateOwnerPassword(unicode), true);
  assert.equal(validateOwnerPassword('x'.repeat(128)), true);
  for (const invalid of [null, 12, '', 'x'.repeat(11), 'x'.repeat(129), '\ud800'.repeat(12), 'x'.repeat(12) + '\udfff']) {
    assert.equal(validateOwnerPassword(invalid), false);
    await assert.rejects(deriveOwnerPassword(invalid), /PASSWORD_POLICY/);
  }
  const verifier = await deriveOwnerPassword(unicode);
  assert.deepEqual(Object.keys(verifier).sort(), ['algorithm', 'hash', 'salt']);
  assert.equal(await verifyOwnerPassword(unicode, verifier), true);
  assert.equal(await verifyOwnerPassword(unicode.trim(), verifier), false);
  assert.equal(await verifyOwnerPassword('é'.repeat(12), await deriveOwnerPassword('e\u0301'.repeat(12))), false);
});

test('fresh salt and Node Argon2id parameters produce verifiable metadata without password', async () => {
  const password = synthetic();
  const first = await deriveOwnerPassword(password);
  const second = await deriveOwnerPassword(password);
  assert.equal(first.algorithm, 'argon2id');
  assert.match(first.salt, /^[0-9a-f]{32}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(JSON.stringify(first).includes(password), false);
  assert.equal(argon2Sync('argon2id', { message: Buffer.from(password, 'utf8'), nonce: Buffer.from(first.salt, 'hex'), memory: 65536, passes: 3, parallelism: 1, tagLength: 32 }).toString('hex'), first.hash);
  assert.equal(await verifyOwnerPassword(synthetic(), first), false);
  assert.equal(await verifyOwnerPassword(null, first), false);
  await assert.rejects(verifyOwnerPassword(password, { ...first, hash: '00' }), /VERIFIER_UNAVAILABLE/);
});

test('owner derivation has a reserved slot and verification admission is bounded', async () => {
  const password = synthetic();
  const verifier = await deriveOwnerPassword(password);
  const owner = deriveOwnerPassword(password);
  await assert.rejects(deriveOwnerPassword(password), /VERIFIER_UNAVAILABLE/);
  const first = verifyOwnerPassword(password, verifier);
  const second = verifyOwnerPassword(password, verifier);
  await assert.rejects(verifyOwnerPassword(password, verifier), /VERIFIER_UNAVAILABLE/);
  assert.equal(await owner.then(() => true), true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});
test('verification binds a validated verifier snapshot across asynchronous derivation', async () => {
  const original = synthetic(), attempted = synthetic();
  const verifier = await deriveOwnerPassword(original);
  const pending = verifyOwnerPassword(attempted, verifier);
  verifier.hash = argon2Sync('argon2id', { message: Buffer.from(attempted, 'utf8'), nonce: Buffer.from(verifier.salt, 'hex'), memory: 65536, passes: 3, parallelism: 1, tagLength: 32 }).toString('hex');
  verifier.salt = randomBytes(16).toString('hex');
  assert.equal(await pending, false);
});
