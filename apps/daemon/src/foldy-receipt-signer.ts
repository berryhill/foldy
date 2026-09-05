import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, sign as signPayload } from 'node:crypto';

import { canonicalFoldyReceiptPayload, type FoldyReceipt } from './foldy-promotion.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const UNSIGNED_RECEIPT_KEYS = [
  'kind',
  'reviewer',
  'decision',
  'project_id',
  'workbook_id',
  'baseline_revision_id',
  'candidate_revision_id',
  'contract',
  'bundle_sha256',
  'protected_manifest_sha256',
  'nonce',
  'task_id',
  'session_id',
  'run_id',
  'issued_at',
] as const;

export type UnsignedFoldyReceipt = Omit<FoldyReceipt, 'signature'>;

/**
 * A deliberately narrow key reference. The signer never falls back to an
 * environment variable, inline key material, or a default custody location.
 */
export type FoldyPrivateKeyReference = Readonly<{
  type: 'file';
  path: string;
}>;

export class FoldyReceiptSignerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FoldyReceiptSignerError';
    this.code = code;
  }

  toJSON(): { name: string; code: string; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

function fail(code: string, message: string): never {
  throw new FoldyReceiptSignerError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function validLogicalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value
    && !path.posix.isAbsolute(value)
    && value !== '.'
    && !value.startsWith('../')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validateUnsignedReceipt(value: unknown): UnsignedFoldyReceipt {
  if (!isPlainObject(value) || !hasExactKeys(value, UNSIGNED_RECEIPT_KEYS)) {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'unsigned receipt does not match the Foldy receipt schema');
  }
  if (value.kind !== 'foldy-wren-review.v1' && value.kind !== 'foldy-assurance.v1') {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'unsupported Foldy receipt kind');
  }
  if (!validId(value.reviewer)) {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'receipt reviewer is invalid');
  }
  if (value.kind === 'foldy-wren-review.v1' && value.reviewer !== 'wren-ashford') {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'Wren review receipts require reviewer wren-ashford');
  }
  if (value.kind === 'foldy-assurance.v1' && value.reviewer === 'wren-ashford') {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'assurance receipts require an independent reviewer');
  }
  if (value.decision !== 'PASS') {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'receipt decision must be PASS');
  }
  for (const key of [
    'project_id',
    'workbook_id',
    'baseline_revision_id',
    'candidate_revision_id',
    'nonce',
    'task_id',
    'session_id',
    'run_id',
  ] as const) {
    if (!validId(value[key])) fail('FOLDY_SIGNER_INVALID_RECEIPT', `receipt ${key} is invalid`);
  }
  if (!isPlainObject(value.contract)
    || !hasExactKeys(value.contract, ['version', 'entry_file', 'root_files'])
    || value.contract.version !== 'foldy-promotion.v1'
    || !validLogicalPath(value.contract.entry_file)
    || !Array.isArray(value.contract.root_files)
    || value.contract.root_files.length === 0
    || !value.contract.root_files.every(validLogicalPath)) {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'receipt contract is invalid');
  }
  if (typeof value.bundle_sha256 !== 'string' || !SHA256.test(value.bundle_sha256)
    || typeof value.protected_manifest_sha256 !== 'string' || !SHA256.test(value.protected_manifest_sha256)) {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'receipt hashes must be lowercase SHA-256 digests');
  }
  if (typeof value.issued_at !== 'string' || !Number.isFinite(Date.parse(value.issued_at))) {
    fail('FOLDY_SIGNER_INVALID_RECEIPT', 'receipt issued_at must be an ISO timestamp');
  }
  return value as unknown as UnsignedFoldyReceipt;
}

async function loadProtectedEd25519PrivateKey(reference: FoldyPrivateKeyReference) {
  if (!reference || reference.type !== 'file' || typeof reference.path !== 'string' || reference.path.length === 0) {
    fail('FOLDY_SIGNER_INVALID_KEY_REFERENCE', 'an explicit private-key file reference is required');
  }
  if (!path.isAbsolute(reference.path)) {
    fail('FOLDY_SIGNER_INVALID_KEY_REFERENCE', 'private-key file path must be absolute');
  }

  let handle;
  try {
    handle = await open(reference.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail('FOLDY_SIGNER_INVALID_KEY_FILE', 'private-key file cannot be opened securely');
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('FOLDY_SIGNER_INVALID_KEY_FILE', 'private-key reference must identify a regular file');
    }
    const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
    if (expectedUid === undefined || stat.uid !== expectedUid) {
      fail('FOLDY_SIGNER_INVALID_KEY_OWNER', 'private-key file must be owned by the signing process user');
    }
    const mode = stat.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600) {
      fail('FOLDY_SIGNER_INSECURE_KEY_MODE', 'private-key file mode must be 0400 or 0600');
    }
    if (stat.size <= 0 || stat.size > MAX_PRIVATE_KEY_BYTES) {
      fail('FOLDY_SIGNER_INVALID_KEY_FILE', 'private-key file size is invalid');
    }

    const encodedKey = await handle.readFile();
    try {
      const privateKey = createPrivateKey(encodedKey);
      if (privateKey.asymmetricKeyType !== 'ed25519') {
        fail('FOLDY_SIGNER_INVALID_KEY', 'private-key file must contain an Ed25519 private key');
      }
      return privateKey;
    } catch (error) {
      if (error instanceof FoldyReceiptSignerError) throw error;
      fail('FOLDY_SIGNER_INVALID_KEY', 'private-key file does not contain a valid Ed25519 private key');
    } finally {
      encodedKey.fill(0);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Sign an exact Foldy receipt payload using a separately-custodied key file.
 * This function performs no logging and does not retain or return key material.
 */
export async function signFoldyReceipt(
  input: unknown,
  privateKeyReference: FoldyPrivateKeyReference,
): Promise<FoldyReceipt> {
  const unsigned = validateUnsignedReceipt(input);
  const privateKey = await loadProtectedEd25519PrivateKey(privateKeyReference);
  const signature = signPayload(null, canonicalFoldyReceiptPayload(unsigned), privateKey).toString('base64');
  return { ...unsigned, signature };
}
