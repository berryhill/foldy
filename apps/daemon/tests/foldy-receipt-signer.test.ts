import { generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalFoldyReceiptPayload, type FoldyReceipt } from '../src/foldy-promotion.js';
import {
  FoldyReceiptSignerError,
  signFoldyReceipt,
  type UnsignedFoldyReceipt,
} from '../src/foldy-receipt-signer.js';

const roots: string[] = [];

function unsignedReceipt(kind: FoldyReceipt['kind']): UnsignedFoldyReceipt {
  return {
    kind,
    reviewer: kind === 'foldy-wren-review.v1' ? 'wren-ashford' : 'independent-assurance',
    decision: 'PASS',
    project_id: 'foldy-project',
    workbook_id: 'workbook-alpha',
    baseline_revision_id: 'rev-000001',
    candidate_revision_id: 'rev-000002',
    contract: {
      version: 'foldy-promotion.v1',
      entry_file: 'index.html',
      root_files: ['workbook.json', 'index.html', 'index.html.artifact.json'],
    },
    bundle_sha256: 'a'.repeat(64),
    protected_manifest_sha256: 'b'.repeat(64),
    nonce: 'nonce-123',
    task_id: 'task-123',
    session_id: 'session-123',
    run_id: 'run-123',
    issued_at: '2026-08-28T12:00:00.000Z',
  };
}

async function fixture(algorithm: 'ed25519' | 'rsa' = 'ed25519') {
  const root = await mkdtemp(path.join(tmpdir(), 'foldy-receipt-signer-'));
  roots.push(root);
  const pair = algorithm === 'ed25519'
    ? generateKeyPairSync('ed25519')
    : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(root, 'receipt-signing-key.pem');
  await writeFile(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return { ...pair, keyPath, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('signFoldyReceipt', () => {
  it.each(['foldy-wren-review.v1', 'foldy-assurance.v1'] as const)(
    'emits an exact, canonically verifiable %s receipt using an ephemeral key',
    async (kind) => {
      const { keyPath, publicKey } = await fixture();
      const unsigned = unsignedReceipt(kind);

      const receipt = await signFoldyReceipt(unsigned, { type: 'file', path: keyPath });

      expect(Object.keys(receipt).sort()).toEqual([
        'baseline_revision_id', 'bundle_sha256', 'candidate_revision_id', 'contract', 'decision',
        'issued_at', 'kind', 'nonce', 'project_id', 'protected_manifest_sha256', 'reviewer',
        'run_id', 'session_id', 'signature', 'task_id', 'workbook_id',
      ].sort());
      const { signature, ...actualUnsigned } = receipt;
      expect(actualUnsigned).toEqual(unsigned);
      expect(Buffer.from(signature, 'base64')).toHaveLength(64);
      expect(verify(null, canonicalFoldyReceiptPayload(actualUnsigned), publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    },
  );

  it('refuses a group- or world-accessible private key', async () => {
    const { keyPath } = await fixture();
    await chmod(keyPath, 0o640);

    await expect(signFoldyReceipt(unsignedReceipt('foldy-assurance.v1'), { type: 'file', path: keyPath }))
      .rejects.toMatchObject({ code: 'FOLDY_SIGNER_INSECURE_KEY_MODE' });
  });

  it('refuses a symlink key reference even when its target is protected', async () => {
    const { keyPath, root } = await fixture();
    const linkPath = path.join(root, 'linked-key.pem');
    await symlink(keyPath, linkPath);

    await expect(signFoldyReceipt(unsignedReceipt('foldy-assurance.v1'), { type: 'file', path: linkPath }))
      .rejects.toMatchObject({ code: 'FOLDY_SIGNER_INVALID_KEY_FILE' });
  });

  it('refuses a private key not owned by the signing process user', async () => {
    const { keyPath } = await fixture();
    const owner = (await stat(keyPath)).uid;
    const originalGeteuid = process.geteuid;
    Object.defineProperty(process, 'geteuid', {
      configurable: true,
      value: () => owner + 1,
    });
    try {
      await expect(signFoldyReceipt(unsignedReceipt('foldy-assurance.v1'), { type: 'file', path: keyPath }))
        .rejects.toMatchObject({ code: 'FOLDY_SIGNER_INVALID_KEY_OWNER' });
    } finally {
      Object.defineProperty(process, 'geteuid', {
        configurable: true,
        value: originalGeteuid,
      });
    }
  });

  it('requires an explicit absolute file reference and never consults a default key location', async () => {
    await expect(signFoldyReceipt(unsignedReceipt('foldy-assurance.v1'), { type: 'file', path: 'key.pem' }))
      .rejects.toMatchObject({ code: 'FOLDY_SIGNER_INVALID_KEY_REFERENCE' });
  });

  it('refuses private keys that are not Ed25519', async () => {
    const { keyPath } = await fixture('rsa');

    await expect(signFoldyReceipt(unsignedReceipt('foldy-assurance.v1'), { type: 'file', path: keyPath }))
      .rejects.toMatchObject({ code: 'FOLDY_SIGNER_INVALID_KEY' });
  });

  it('rejects extra receipt fields instead of signing a divergent schema', async () => {
    const { keyPath } = await fixture();
    const input = { ...unsignedReceipt('foldy-assurance.v1'), unexpected: 'field' };

    await expect(signFoldyReceipt(input, { type: 'file', path: keyPath }))
      .rejects.toMatchObject({ code: 'FOLDY_SIGNER_INVALID_RECEIPT' });
  });

  it('enforces the canonical Wren reviewer identity', async () => {
    const { keyPath } = await fixture();
    const input = { ...unsignedReceipt('foldy-wren-review.v1'), reviewer: 'someone-else' };

    await expect(signFoldyReceipt(input, { type: 'file', path: keyPath }))
      .rejects.toMatchObject({ code: 'FOLDY_SIGNER_INVALID_RECEIPT' });
  });

  it('returns redacted errors when key parsing fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'foldy-receipt-signer-'));
    roots.push(root);
    const keyPath = path.join(root, 'invalid.pem');
    const sensitiveMarker = 'DO-NOT-EXPOSE-KEY-MATERIAL';
    await writeFile(keyPath, sensitiveMarker, { mode: 0o600 });
    await chmod(keyPath, 0o600);

    let caught: unknown;
    try {
      await signFoldyReceipt(unsignedReceipt('foldy-assurance.v1'), { type: 'file', path: keyPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FoldyReceiptSignerError);
    expect(String(caught)).not.toContain(sensitiveMarker);
    expect(JSON.stringify(caught)).not.toContain(sensitiveMarker);
  });
});
