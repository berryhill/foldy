import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_DECISION = 'PASS';
const REQUIRED_POINTER_FILE = 'workbook.json';
const locks = new Map<string, Promise<void>>();

export type FoldyProjectMetadata = Record<string, unknown> & {
  revisionId?: string;
  currentRevisionId?: string;
  workbookId?: string;
  entryFile?: string;
  foldy?: boolean;
};

export interface FoldyReceipt {
  kind: 'foldy-wren-review.v1' | 'foldy-assurance.v1';
  reviewer: string;
  decision: 'PASS';
  project_id: string;
  workbook_id: string;
  baseline_revision_id: string;
  candidate_revision_id: string;
  contract: {
    version: 'foldy-promotion.v1';
    entry_file: string;
    root_files: string[];
  };
  bundle_sha256: string;
  protected_manifest_sha256: string;
  nonce: string;
  task_id: string;
  session_id: string;
  run_id: string;
  issued_at: string;
  signature: string;
}

export interface FoldyPromotionRequest {
  version: 'foldy-promotion.v1';
  expectedCurrentRevisionId: string;
  candidateRevisionId: string;
  candidateBundleSha256: string;
  entryFile: string;
  rootFiles: string[];
  protectedSurfaces: Array<{ path: string; sha256: string }>;
  wrenReceipt: FoldyReceipt;
  assuranceReceipt: FoldyReceipt;
}

export interface PromoteFoldyOptions {
  projectId: string;
  projectRoot: string;
  request: unknown;
  readProjectMetadata: () => Promise<FoldyProjectMetadata | null> | FoldyProjectMetadata | null;
  compareAndSetProjectMetadata: (
    expected: FoldyProjectMetadata,
    replacement: FoldyProjectMetadata,
  ) => Promise<boolean> | boolean;
  hooks?: {
    afterRootWrite?: (logicalPath: string) => Promise<void> | void;
    beforeRollbackRestore?: () => Promise<void> | void;
  };
}

export interface FoldyLegacyBaselineEnrollmentRequest {
  version: 'foldy-legacy-baseline-enrollment.v1';
  expectedCurrentRevisionId: string;
}

export interface EnrollLegacyFoldyBaselineOptions {
  projectId: string;
  projectRoot: string;
  request: unknown;
  readProjectMetadata: () => Promise<FoldyProjectMetadata | null> | FoldyProjectMetadata | null;
  compareAndSetProjectMetadata: (
    expected: FoldyProjectMetadata,
    replacement: FoldyProjectMetadata,
  ) => Promise<boolean> | boolean;
}

export interface FoldyNoProtectedAncestorRepairRequest {
  version: 'foldy-no-protected-ancestor-repair.v1';
  expectedCurrentRevisionId: string;
  repairRevisionId: string;
  dedupKey: string;
}

export interface RepairFoldyNoProtectedAncestorOptions extends Omit<EnrollLegacyFoldyBaselineOptions, 'request'> {
  request: unknown;
}

export class FoldyPromotionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FoldyPromotionError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status: number, code: string, message: string, details?: Record<string, unknown>): never {
  throw new FoldyPromotionError(status, code, message, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(400, 'FOLDY_INVALID_REQUEST', `${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function safeLogicalPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\')) {
    fail(400, 'FOLDY_INVALID_REQUEST', `${label} must be a non-empty POSIX relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || path.posix.isAbsolute(value) || value === '.' || value.startsWith('../')) {
    fail(400, 'FOLDY_INVALID_REQUEST', `${label} is not a safe relative path`);
  }
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(400, 'FOLDY_INVALID_REQUEST', `${label} is not a safe relative path`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail(400, 'FOLDY_INVALID_REQUEST', `${label} is invalid`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(400, 'FOLDY_INVALID_REQUEST', `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

const RECEIPT_KEYS = [
  'kind', 'reviewer', 'decision', 'project_id', 'workbook_id', 'baseline_revision_id',
  'candidate_revision_id', 'contract', 'bundle_sha256', 'protected_manifest_sha256',
  'nonce', 'task_id', 'session_id', 'run_id', 'issued_at', 'signature',
] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalFoldyReceiptPayload(receipt: Omit<FoldyReceipt, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(receipt), 'utf8');
}

function parseReceiptShape(value: unknown, expectedKind: FoldyReceipt['kind']): FoldyReceipt {
  if (!isPlainObject(value)) fail(400, 'FOLDY_INVALID_RECEIPT', `${expectedKind} receipt is required`);
  exactKeys(value, RECEIPT_KEYS, `${expectedKind} receipt`);
  if (value.kind !== expectedKind) fail(400, 'FOLDY_INVALID_RECEIPT', `receipt kind must be ${expectedKind}`);
  if (typeof value.reviewer !== 'string' || !ID.test(value.reviewer)) {
    fail(400, 'FOLDY_INVALID_RECEIPT', 'receipt reviewer is invalid');
  }
  if (value.decision !== RECEIPT_DECISION) {
    fail(422, expectedKind === 'foldy-wren-review.v1' ? 'FOLDY_WREN_NOT_PASS' : 'FOLDY_ASSURANCE_NOT_PASS', `${expectedKind} decision must be PASS`);
  }
  for (const key of ['project_id', 'workbook_id', 'baseline_revision_id', 'candidate_revision_id', 'nonce', 'task_id', 'session_id', 'run_id'] as const) {
    requireId(value[key], `receipt.${key}`);
  }
  if (!isPlainObject(value.contract)) fail(400, 'FOLDY_INVALID_RECEIPT', 'receipt contract is invalid');
  exactKeys(value.contract, ['version', 'entry_file', 'root_files'], 'receipt contract');
  if (value.contract.version !== 'foldy-promotion.v1') fail(400, 'FOLDY_INVALID_RECEIPT', 'receipt contract version is invalid');
  safeLogicalPath(value.contract.entry_file, 'receipt.contract.entry_file');
  if (!Array.isArray(value.contract.root_files) || value.contract.root_files.length === 0) {
    fail(400, 'FOLDY_INVALID_RECEIPT', 'receipt contract root_files is invalid');
  }
  value.contract.root_files.forEach((item, index) => safeLogicalPath(item, `receipt.contract.root_files[${index}]`));
  requireHash(value.bundle_sha256, 'receipt.bundle_sha256');
  requireHash(value.protected_manifest_sha256, 'receipt.protected_manifest_sha256');
  if (typeof value.issued_at !== 'string' || !Number.isFinite(Date.parse(value.issued_at))) {
    fail(400, 'FOLDY_INVALID_RECEIPT', 'receipt issued_at must be an ISO timestamp');
  }
  if (typeof value.signature !== 'string' || value.signature.length === 0) {
    fail(400, 'FOLDY_INVALID_RECEIPT', 'receipt signature is required');
  }
  return value as unknown as FoldyReceipt;
}

function verifyReceipt(
  receipt: FoldyReceipt,
  expectedKind: FoldyReceipt['kind'],
  bindings: Omit<FoldyReceipt, 'kind' | 'reviewer' | 'decision' | 'nonce' | 'task_id' | 'session_id' | 'run_id' | 'issued_at' | 'signature'>,
): void {
  if (expectedKind === 'foldy-wren-review.v1' && receipt.reviewer !== 'wren-ashford') {
    fail(403, 'FOLDY_WREN_REQUIRED', 'Wren receipt reviewer must be wren-ashford');
  }
  for (const [key, expected] of Object.entries(bindings)) {
    if (canonicalJson(receipt[key as keyof FoldyReceipt]) !== canonicalJson(expected)) {
      fail(422, 'FOLDY_RECEIPT_BINDING_MISMATCH', `${expectedKind} ${key} does not bind this promotion`);
    }
  }
  const envName = expectedKind === 'foldy-wren-review.v1'
    ? 'OD_FOLDY_WREN_PUBLIC_KEY'
    : 'OD_FOLDY_ASSURANCE_PUBLIC_KEY';
  const encodedKey = process.env[envName];
  if (!encodedKey) fail(503, 'FOLDY_RECEIPT_KEYS_UNAVAILABLE', `${envName} is not configured`);
  try {
    const publicKey = createPublicKey(encodedKey);
    const { signature, ...unsigned } = receipt;
    if (!verifySignature(null, canonicalFoldyReceiptPayload(unsigned), publicKey, Buffer.from(signature, 'base64'))) {
      fail(403, 'FOLDY_INVALID_RECEIPT_SIGNATURE', `${expectedKind} signature verification failed`);
    }
  } catch (error) {
    if (error instanceof FoldyPromotionError) throw error;
    fail(503, 'FOLDY_RECEIPT_KEYS_UNAVAILABLE', `${envName} is not a valid Ed25519 public key`);
  }
}

function assertConfiguredReceiptKeysAreIndependent(): void {
  const wrenEncoded = process.env.OD_FOLDY_WREN_PUBLIC_KEY;
  const assuranceEncoded = process.env.OD_FOLDY_ASSURANCE_PUBLIC_KEY;
  if (!wrenEncoded || !assuranceEncoded) {
    fail(503, 'FOLDY_RECEIPT_KEYS_UNAVAILABLE', 'both Foldy receipt public keys must be configured');
  }
  try {
    const wrenDer = createPublicKey(wrenEncoded).export({ format: 'der', type: 'spki' });
    const assuranceDer = createPublicKey(assuranceEncoded).export({ format: 'der', type: 'spki' });
    if (Buffer.compare(wrenDer, assuranceDer) === 0) {
      fail(503, 'FOLDY_RECEIPT_KEYS_NOT_INDEPENDENT', 'Wren and assurance must use distinct public keys');
    }
  } catch (error) {
    if (error instanceof FoldyPromotionError) throw error;
    fail(503, 'FOLDY_RECEIPT_KEYS_UNAVAILABLE', 'Foldy receipt public keys must be valid Ed25519 public keys');
  }
}

export function parseFoldyLegacyBaselineEnrollmentRequest(
  projectId: string,
  value: unknown,
): FoldyLegacyBaselineEnrollmentRequest {
  requireId(projectId, 'projectId');
  if (!isPlainObject(value)) fail(400, 'FOLDY_INVALID_REQUEST', 'request body must be an object');
  exactKeys(value, ['version', 'expectedCurrentRevisionId'], 'legacy baseline enrollment request');
  if (value.version !== 'foldy-legacy-baseline-enrollment.v1') {
    fail(400, 'FOLDY_INVALID_REQUEST', 'version must be foldy-legacy-baseline-enrollment.v1');
  }
  return {
    version: 'foldy-legacy-baseline-enrollment.v1',
    expectedCurrentRevisionId: requireId(value.expectedCurrentRevisionId, 'expectedCurrentRevisionId'),
  };
}

export function parseFoldyNoProtectedAncestorRepairRequest(
  projectId: string,
  value: unknown,
): FoldyNoProtectedAncestorRepairRequest {
  requireId(projectId, 'projectId');
  if (!isPlainObject(value)) fail(400, 'FOLDY_INVALID_REQUEST', 'request body must be an object');
  exactKeys(value, ['version', 'expectedCurrentRevisionId', 'repairRevisionId', 'dedupKey'], 'no-protected-ancestor repair request');
  if (value.version !== 'foldy-no-protected-ancestor-repair.v1') {
    fail(400, 'FOLDY_INVALID_REQUEST', 'version must be foldy-no-protected-ancestor-repair.v1');
  }
  const expectedCurrentRevisionId = requireId(value.expectedCurrentRevisionId, 'expectedCurrentRevisionId');
  const repairRevisionId = requireId(value.repairRevisionId, 'repairRevisionId');
  if (repairRevisionId === expectedCurrentRevisionId) {
    fail(400, 'FOLDY_INVALID_REQUEST', 'repairRevisionId must differ from expectedCurrentRevisionId');
  }
  return {
    version: 'foldy-no-protected-ancestor-repair.v1',
    expectedCurrentRevisionId,
    repairRevisionId,
    dedupKey: requireId(value.dedupKey, 'dedupKey'),
  };
}

export function parseFoldyPromotionRequest(projectId: string, value: unknown): FoldyPromotionRequest {
  if (!isPlainObject(value)) fail(400, 'FOLDY_INVALID_REQUEST', 'request body must be an object');
  exactKeys(
    value,
    [
      'version', 'expectedCurrentRevisionId', 'candidateRevisionId', 'candidateBundleSha256',
      'entryFile', 'rootFiles', 'protectedSurfaces', 'wrenReceipt', 'assuranceReceipt',
    ],
    'promotion request',
  );
  if (value.version !== 'foldy-promotion.v1') {
    fail(400, 'FOLDY_INVALID_REQUEST', 'version must be foldy-promotion.v1');
  }
  requireId(projectId, 'projectId');
  const expectedCurrentRevisionId = requireId(value.expectedCurrentRevisionId, 'expectedCurrentRevisionId');
  const candidateRevisionId = requireId(value.candidateRevisionId, 'candidateRevisionId');
  if (candidateRevisionId === expectedCurrentRevisionId) {
    fail(400, 'FOLDY_INVALID_REQUEST', 'candidateRevisionId must differ from expectedCurrentRevisionId');
  }
  const candidateBundleSha256 = requireHash(value.candidateBundleSha256, 'candidateBundleSha256');
  const entryFile = safeLogicalPath(value.entryFile, 'entryFile');
  if (entryFile.startsWith('revisions/')) fail(400, 'FOLDY_INVALID_REQUEST', 'entryFile must be a root path');

  if (!Array.isArray(value.rootFiles) || value.rootFiles.length === 0) {
    fail(400, 'FOLDY_INVALID_REQUEST', 'rootFiles must be a non-empty array');
  }
  const rootFiles = value.rootFiles.map((item, index) => safeLogicalPath(item, `rootFiles[${index}]`));
  if (new Set(rootFiles).size !== rootFiles.length || rootFiles.some((item) => item.startsWith('revisions/'))) {
    fail(400, 'FOLDY_INVALID_REQUEST', 'rootFiles must be unique root paths');
  }
  for (const mandatory of [REQUIRED_POINTER_FILE, entryFile, `${entryFile}.artifact.json`]) {
    if (!rootFiles.includes(mandatory)) {
      fail(400, 'FOLDY_INVALID_REQUEST', `rootFiles must include ${mandatory}`);
    }
  }

  if (!Array.isArray(value.protectedSurfaces) || value.protectedSurfaces.length === 0) {
    fail(400, 'FOLDY_INVALID_REQUEST', 'protectedSurfaces must be a non-empty array');
  }
  const protectedSurfaces = value.protectedSurfaces.map((item, index) => {
    if (!isPlainObject(item)) fail(400, 'FOLDY_INVALID_REQUEST', `protectedSurfaces[${index}] must be an object`);
    exactKeys(item, ['path', 'sha256'], `protectedSurfaces[${index}]`);
    const logicalPath = safeLogicalPath(item.path, `protectedSurfaces[${index}].path`);
    if (rootFiles.includes(logicalPath) || logicalPath.startsWith('revisions/')) {
      fail(400, 'FOLDY_INVALID_REQUEST', 'protected surfaces cannot overlap promoted or revision files');
    }
    return { path: logicalPath, sha256: requireHash(item.sha256, `protectedSurfaces[${index}].sha256`) };
  });
  if (new Set(protectedSurfaces.map((item) => item.path)).size !== protectedSurfaces.length) {
    fail(400, 'FOLDY_INVALID_REQUEST', 'protected surface paths must be unique');
  }
  const wrenReceipt = parseReceiptShape(value.wrenReceipt, 'foldy-wren-review.v1');
  const assuranceReceipt = parseReceiptShape(value.assuranceReceipt, 'foldy-assurance.v1');
  if (assuranceReceipt.reviewer === wrenReceipt.reviewer) {
    fail(422, 'FOLDY_ASSURANCE_NOT_INDEPENDENT', 'assurance reviewer must be independent of Wren review');
  }

  return {
    version: 'foldy-promotion.v1', expectedCurrentRevisionId, candidateRevisionId,
    candidateBundleSha256, entryFile, rootFiles, protectedSurfaces, wrenReceipt, assuranceReceipt,
  };
}

function currentRevision(metadata: FoldyProjectMetadata): string | null {
  if (typeof metadata.revisionId === 'string') return metadata.revisionId;
  if (typeof metadata.currentRevisionId === 'string') return metadata.currentRevisionId;
  return null;
}

function legacyDraftPreviewRevision(metadata: FoldyProjectMetadata): string | null {
  if (metadata.kind !== 'foldy-draft-preview' || metadata.foldy === true || currentRevision(metadata) !== null) {
    return null;
  }
  if (typeof metadata.candidateRevisionId !== 'string' || !ID.test(metadata.candidateRevisionId)) {
    return null;
  }
  if (typeof metadata.entryFile !== 'string') return null;
  const entryFile = safeLogicalPath(metadata.entryFile, 'metadata.entryFile');
  return entryFile.startsWith(`drafts/${metadata.candidateRevisionId}/`)
    ? metadata.candidateRevisionId
    : null;
}

async function assertContainedPath(root: string, logicalPath: string): Promise<string> {
  const rootReal = await realpath(root).catch(() => fail(422, 'FOLDY_PATH_ESCAPE', 'project root is unavailable'));
  let cursor = rootReal;
  for (const segment of logicalPath.split('/')) {
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      fail(422, 'FOLDY_PATH_ESCAPE', `symbolic-link path component rejected: ${logicalPath}`);
    }
    const resolved = await realpath(cursor);
    if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
      fail(422, 'FOLDY_PATH_ESCAPE', `path escapes project root: ${logicalPath}`);
    }
  }
  return path.join(rootReal, ...logicalPath.split('/'));
}

async function regularFileBytes(root: string, logicalPath: string): Promise<Buffer> {
  const fullPath = await assertContainedPath(root, logicalPath);
  const fileStat = await lstat(fullPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') fail(422, 'FOLDY_CANDIDATE_INCOMPLETE', `missing file: ${logicalPath}`);
    throw error;
  });
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    fail(422, 'FOLDY_CANDIDATE_INCOMPLETE', `not an immutable regular file: ${logicalPath}`);
  }
  return readFile(fullPath);
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function collectRegularFiles(root: string, relative = ''): Promise<Array<{ path: string; bytes: Buffer }>> {
  const dir = relative ? path.join(root, ...relative.split('/')) : root;
  const dirStat = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') fail(422, 'FOLDY_CANDIDATE_INCOMPLETE', 'candidate revision directory is missing');
    throw error;
  });
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    fail(422, 'FOLDY_PATH_ESCAPE', `candidate directory must not be a symbolic link: ${relative || '.'}`);
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const logicalPath = relative ? `${relative}/${entry.name}` : entry.name;
    const fullPath = path.join(root, ...logicalPath.split('/'));
    const currentStat = await lstat(fullPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') fail(422, 'FOLDY_CANDIDATE_MUTATED', `candidate entry vanished: ${logicalPath}`);
      throw error;
    });
    if (currentStat.isSymbolicLink() || (!currentStat.isFile() && !currentStat.isDirectory())) {
      fail(422, 'FOLDY_CANDIDATE_INCOMPLETE', `candidate contains unsupported entry: ${logicalPath}`);
    }
    if (currentStat.isDirectory()) {
      files.push(...await collectRegularFiles(root, logicalPath));
    } else {
      const parentReal = await realpath(path.dirname(fullPath));
      const rootReal = await realpath(root);
      if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
        fail(422, 'FOLDY_PATH_ESCAPE', `candidate path escapes revision root: ${logicalPath}`);
      }
      const finalStat = await lstat(fullPath);
      if (!finalStat.isFile() || finalStat.isSymbolicLink()) {
        fail(422, 'FOLDY_CANDIDATE_MUTATED', `candidate entry changed before read: ${logicalPath}`);
      }
      files.push({ path: logicalPath, bytes: await readFile(fullPath) });
    }
  }
  return files;
}

export function hashBundle(files: Array<{ path: string; bytes: Buffer }>): string {
  const manifest = files
    .map(({ path: logicalPath, bytes }) => {
      let hashBytes = bytes;
      // The revision manifest binds a bundle containing itself. Normalize its
      // own digest fields before hashing to avoid an impossible hash fixed point.
      // Persisted bytes are never changed and remain the parity authority.
      if (logicalPath === REQUIRED_POINTER_FILE) {
        try {
          const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
          if (Array.isArray(parsed.revisions)) {
            const normalized = structuredClone(parsed);
            for (const revision of normalized.revisions as unknown[]) {
              if (isPlainObject(revision) && Object.prototype.hasOwnProperty.call(revision, 'bundleSha256')) {
                revision.bundleSha256 = null;
              }
            }
            hashBytes = Buffer.from(JSON.stringify(normalized), 'utf8');
          }
        } catch {
          // Candidate validation reports malformed JSON; raw hashing remains deterministic.
        }
      }
      return { path: logicalPath, bytes: hashBytes.length, sha256: sha256(hashBytes) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return sha256(JSON.stringify(manifest));
}

export function hashProtectedSurfaceContract(surfaces: Array<{ path: string; sha256: string }>): string {
  return sha256(canonicalJson([...surfaces].sort((a, b) => a.path.localeCompare(b.path))));
}

async function loadAuthoritativeProtectedManifest(
  projectRoot: string,
  baselineRevisionId: string,
  metadata: FoldyProjectMetadata,
): Promise<{ workbookId: string; surfaces: Array<{ path: string; sha256: string }> }> {
  let workbook: unknown;
  try {
    workbook = JSON.parse((await regularFileBytes(
      projectRoot,
      `revisions/${baselineRevisionId}/${REQUIRED_POINTER_FILE}`,
    )).toString('utf8'));
  } catch (error) {
    if (error instanceof FoldyPromotionError) throw error;
    fail(422, 'FOLDY_PROTECTED_BASELINE_INVALID', 'protected baseline workbook is invalid JSON');
  }
  if (!isPlainObject(workbook) || typeof workbook.workbookId !== 'string' || !ID.test(workbook.workbookId)) {
    fail(422, 'FOLDY_PROTECTED_BASELINE_INVALID', 'protected baseline workbook identity is invalid');
  }
  if (typeof metadata.workbookId === 'string' && metadata.workbookId !== workbook.workbookId) {
    fail(409, 'FOLDY_PROTECTED_BASELINE_INVALID', 'protected baseline workbook does not match project envelope');
  }
  const revision = Array.isArray(workbook.revisions)
    ? workbook.revisions.find((item) => isPlainObject(item) && item.revisionId === baselineRevisionId)
    : undefined;
  if (!isPlainObject(revision) || revision.state !== 'FROZEN' || !Array.isArray(revision.protectedSurfaces) || revision.protectedSurfaces.length === 0) {
    fail(422, 'FOLDY_PROTECTED_BASELINE_REQUIRED', 'frozen baseline must declare a non-empty protectedSurfaces manifest');
  }
  const surfaces = revision.protectedSurfaces.map((item, index) => {
    if (!isPlainObject(item)) fail(422, 'FOLDY_PROTECTED_BASELINE_INVALID', `baseline protectedSurfaces[${index}] is invalid`);
    exactKeys(item, ['path', 'sha256'], `baseline protectedSurfaces[${index}]`);
    return {
      path: safeLogicalPath(item.path, `baseline protectedSurfaces[${index}].path`),
      sha256: requireHash(item.sha256, `baseline protectedSurfaces[${index}].sha256`),
    };
  });
  if (new Set(surfaces.map((item) => item.path)).size !== surfaces.length) {
    fail(422, 'FOLDY_PROTECTED_BASELINE_INVALID', 'baseline protected surface paths must be unique');
  }
  return { workbookId: workbook.workbookId, surfaces };
}

async function verifyProtectedSurfaces(root: string, surfaces: Array<{ path: string; sha256: string }>): Promise<void> {
  for (const surface of surfaces) {
    const actual = sha256(await regularFileBytes(root, surface.path));
    if (actual !== surface.sha256) {
      fail(409, 'FOLDY_PROTECTED_SURFACE_DRIFT', `protected surface drift: ${surface.path}`, {
        path: surface.path, expectedSha256: surface.sha256, actualSha256: actual,
      });
    }
  }
}

function validateCandidateWorkbook(bytes: Buffer, request: FoldyPromotionRequest): { workbookId: string } {
  let workbook: Record<string, unknown>;
  try {
    workbook = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    fail(422, 'FOLDY_CANDIDATE_INVALID', 'candidate workbook.json is not valid JSON');
  }
  if (!isPlainObject(workbook) || typeof workbook.workbookId !== 'string' || !ID.test(workbook.workbookId)) {
    fail(422, 'FOLDY_CANDIDATE_INVALID', 'candidate workbookId is missing or invalid');
  }
  if (!Array.isArray(workbook.revisions)) {
    fail(422, 'FOLDY_CANDIDATE_INVALID', 'candidate workbook revisions are missing');
  }
  const revision = workbook.revisions.find(
    (item) => isPlainObject(item) && item.revisionId === request.candidateRevisionId,
  ) as Record<string, unknown> | undefined;
  if (!revision || revision.state !== 'FROZEN') {
    fail(422, 'FOLDY_CANDIDATE_NOT_FROZEN', 'candidate revision must exist in workbook.json with state FROZEN');
  }
  if (revision.bundleSha256 !== request.candidateBundleSha256) {
    fail(422, 'FOLDY_CANDIDATE_HASH_MISMATCH', 'candidate revision bundleSha256 does not match request');
  }
  return { workbookId: workbook.workbookId };
}

async function restoreRootFiles(
  root: string,
  backups: Map<string, Buffer | null>,
): Promise<void> {
  for (const [logicalPath, prior] of backups) {
    let target = await assertContainedPath(root, logicalPath);
    if (prior === null) {
      target = await assertContainedPath(root, logicalPath);
      await rm(target, { force: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      target = await assertContainedPath(root, logicalPath);
      await writeFile(target, prior);
    }
  }
}

export async function withFoldyProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => current);
  locks.set(projectId, tail);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(projectId) === tail) locks.delete(projectId);
  }
}

export async function enrollLegacyFoldyBaseline(
  options: EnrollLegacyFoldyBaselineOptions,
): Promise<Record<string, unknown>> {
  return withFoldyProjectLock(options.projectId, async () => {
    const request = parseFoldyLegacyBaselineEnrollmentRequest(options.projectId, options.request);
    const metadata = await options.readProjectMetadata();
    if (!metadata) fail(404, 'FOLDY_PROJECT_NOT_FOUND', 'project disappeared during legacy Foldy enrollment');
    const envelopeCurrent = currentRevision(metadata);
    const draftPreviewCurrent = envelopeCurrent === null ? legacyDraftPreviewRevision(metadata) : null;
    const authoritativeCurrent = envelopeCurrent ?? draftPreviewCurrent;
    if (authoritativeCurrent !== request.expectedCurrentRevisionId) {
      fail(409, 'FOLDY_STALE_CURRENT', 'expected current revision does not match project envelope', {
        expectedCurrentRevisionId: request.expectedCurrentRevisionId,
        actualCurrentRevisionId: authoritativeCurrent,
      });
    }

    const entryFile = typeof metadata.entryFile === 'string'
      ? safeLogicalPath(metadata.entryFile, 'metadata.entryFile')
      : 'index.html';
    if (entryFile.startsWith('revisions/')) {
      fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', 'legacy entry file must be a root path');
    }
    const sourceWorkbookPath = draftPreviewCurrent
      ? path.posix.join(path.posix.dirname(entryFile), REQUIRED_POINTER_FILE)
      : REQUIRED_POINTER_FILE;
    const rootFileSources = [
      { baselinePath: REQUIRED_POINTER_FILE, sourcePath: sourceWorkbookPath },
      { baselinePath: entryFile, sourcePath: entryFile },
      { baselinePath: `${entryFile}.artifact.json`, sourcePath: `${entryFile}.artifact.json` },
    ];
    const rootBytes = new Map<string, Buffer>();
    for (const { baselinePath, sourcePath } of rootFileSources) {
      rootBytes.set(baselinePath, await regularFileBytes(options.projectRoot, sourcePath));
    }

    let legacyWorkbook: Record<string, unknown>;
    try {
      legacyWorkbook = JSON.parse(rootBytes.get(REQUIRED_POINTER_FILE)!.toString('utf8')) as Record<string, unknown>;
    } catch {
      fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', 'legacy workbook.json is not valid JSON');
    }
    if (!isPlainObject(legacyWorkbook)
      || typeof legacyWorkbook.workbookId !== 'string'
      || !ID.test(legacyWorkbook.workbookId)) {
      fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', 'legacy workbook identity is missing or invalid');
    }
    if (typeof metadata.workbookId === 'string' && metadata.workbookId !== legacyWorkbook.workbookId) {
      fail(409, 'FOLDY_WORKBOOK_IDENTITY_MISMATCH', 'legacy workbook does not match project envelope');
    }
    const historicalRevisions = legacyWorkbook.revisions === undefined
      ? []
      : legacyWorkbook.revisions;
    if (!Array.isArray(historicalRevisions)) {
      fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', 'legacy workbook revisions must be an array');
    }
    const historicalRevisionIds = new Set<string>();
    for (const [index, revision] of historicalRevisions.entries()) {
      if (!isPlainObject(revision)
        || typeof revision.revisionId !== 'string'
        || !ID.test(revision.revisionId)) {
        fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', `legacy workbook revisions[${index}] is invalid`);
      }
      if (historicalRevisionIds.has(revision.revisionId)) {
        fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', 'legacy workbook revision ids must be unique');
      }
      historicalRevisionIds.add(revision.revisionId);
      if (revision.protectedSurfaces !== undefined && !Array.isArray(revision.protectedSurfaces)) {
        fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', `legacy workbook revisions[${index}].protectedSurfaces is invalid`);
      }
      if (revision.state === 'FROZEN'
        || (Array.isArray(revision.protectedSurfaces) && revision.protectedSurfaces.length > 0)) {
        fail(409, 'FOLDY_LEGACY_BASELINE_ALREADY_ENROLLED', 'legacy workbook already contains Foldy enrollment controls');
      }
      if (revision.state !== 'DRAFT') {
        fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', `legacy workbook revisions[${index}] must be an unenrolled DRAFT`);
      }
    }
    const historicalCurrentRevisionIndex = historicalRevisions.findIndex(
      (revision) => revision.revisionId === authoritativeCurrent,
    );
    if (historicalCurrentRevisionIndex >= 0
      && historicalCurrentRevisionIndex !== historicalRevisions.length - 1) {
      fail(422, 'FOLDY_LEGACY_BASELINE_INVALID', 'legacy current revision must be the final historical DRAFT');
    }
    if (typeof legacyWorkbook.currentRevisionId === 'string'
      || (Array.isArray(legacyWorkbook.protectedSurfaces) && legacyWorkbook.protectedSurfaces.length > 0)) {
      fail(409, 'FOLDY_LEGACY_BASELINE_ALREADY_ENROLLED', 'legacy workbook already contains Foldy enrollment controls');
    }

    const projectReal = await realpath(options.projectRoot)
      .catch(() => fail(422, 'FOLDY_PATH_ESCAPE', 'project root is unavailable'));
    const baselineLogicalPath = `revisions/${authoritativeCurrent}`;
    const baselineTarget = await assertContainedPath(options.projectRoot, baselineLogicalPath);
    const controlLogicalPath = '.foldy-baseline-control.json';
    const controlTarget = await assertContainedPath(options.projectRoot, controlLogicalPath);
    const preexistingBaseline = await lstat(baselineTarget).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const preexistingControl = await lstat(controlTarget).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (preexistingBaseline || preexistingControl || typeof metadata.currentRevisionId === 'string') {
      fail(409, 'FOLDY_LEGACY_BASELINE_ALREADY_ENROLLED', 'legacy Foldy baseline enrollment is one-shot');
    }

    const control = {
      version: 'foldy-legacy-baseline-control.v1',
      projectId: options.projectId,
      workbookId: legacyWorkbook.workbookId,
      revisionId: authoritativeCurrent,
      entryFile,
      rootFiles: rootFileSources
        .map(({ baselinePath, sourcePath }) => ({ path: sourcePath, sha256: sha256(rootBytes.get(baselinePath)!) }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    const controlBytes = Buffer.from(JSON.stringify(control), 'utf8');
    const protectedSurfaces = [{ path: controlLogicalPath, sha256: sha256(controlBytes) }];
    const historicalCurrentRevision = historicalCurrentRevisionIndex >= 0
      ? historicalRevisions[historicalCurrentRevisionIndex] as Record<string, unknown>
      : null;
    const enrollmentRevision: Record<string, unknown> = {
      ...(historicalCurrentRevision ? structuredClone(historicalCurrentRevision) : {}),
      revisionId: authoritativeCurrent,
      ...(!historicalCurrentRevision && historicalRevisions.length > 0
        ? { parentRevisionId: (historicalRevisions.at(-1) as Record<string, unknown>).revisionId }
        : {}),
      state: 'FROZEN',
      bundleSha256: null as string | null,
      protectedSurfaces,
    };
    const baselineWorkbook = structuredClone(legacyWorkbook);
    baselineWorkbook.revisions = historicalCurrentRevisionIndex >= 0
      ? historicalRevisions.map((revision, index) => (
        index === historicalCurrentRevisionIndex
          ? enrollmentRevision
          : structuredClone(revision)
      ))
      : [
          ...structuredClone(historicalRevisions),
          enrollmentRevision,
        ];

    const transactionId = randomUUID();
    const stagingRoot = path.join(projectReal, `.foldy-enrollment-${transactionId}`);
    const stagedBaseline = path.join(stagingRoot, 'baseline');
    const stagedControl = path.join(stagingRoot, 'control.json');
    const enrolledMetadata: FoldyProjectMetadata = {
      ...metadata,
      foldy: true,
      workbookId: legacyWorkbook.workbookId,
      revisionId: authoritativeCurrent,
      currentRevisionId: authoritativeCurrent,
      entryFile,
    };
    let baselineInstalled = false;
    let controlInstalled = false;
    let metadataUpdated = false;
    await mkdir(stagedBaseline, { recursive: true });
    try {
      await mkdir(path.dirname(path.join(stagedBaseline, entryFile)), { recursive: true });
      await writeFile(path.join(stagedBaseline, entryFile), rootBytes.get(entryFile)!);
      await mkdir(path.dirname(path.join(stagedBaseline, `${entryFile}.artifact.json`)), { recursive: true });
      await writeFile(path.join(stagedBaseline, `${entryFile}.artifact.json`), rootBytes.get(`${entryFile}.artifact.json`)!);
      const stagedWorkbookPath = path.join(stagedBaseline, REQUIRED_POINTER_FILE);
      await writeFile(stagedWorkbookPath, JSON.stringify(baselineWorkbook));
      enrollmentRevision.bundleSha256 = hashBundle(await collectRegularFiles(stagedBaseline));
      await writeFile(stagedWorkbookPath, JSON.stringify(baselineWorkbook));
      if (hashBundle(await collectRegularFiles(stagedBaseline)) !== enrollmentRevision.bundleSha256) {
        fail(500, 'FOLDY_STAGE_PARITY_FAILED', 'legacy baseline bundle parity failed');
      }
      await writeFile(stagedControl, controlBytes);

      await mkdir(path.dirname(baselineTarget), { recursive: true });
      await assertContainedPath(options.projectRoot, baselineLogicalPath);
      await rename(stagedBaseline, baselineTarget);
      baselineInstalled = true;
      await assertContainedPath(options.projectRoot, controlLogicalPath);
      await writeFile(controlTarget, await readFile(stagedControl), { flag: 'wx' });
      controlInstalled = true;

      if (!await options.compareAndSetProjectMetadata(metadata, enrolledMetadata)) {
        fail(409, 'FOLDY_METADATA_CAS_FAILED', 'project metadata changed during legacy Foldy enrollment');
      }
      metadataUpdated = true;

      for (const { baselinePath, sourcePath } of rootFileSources) {
        if (sha256(await regularFileBytes(options.projectRoot, sourcePath)) !== sha256(rootBytes.get(baselinePath)!)) {
          fail(500, 'FOLDY_POINTER_PARITY_FAILED', `legacy root pointer byte parity failed: ${sourcePath}`);
        }
      }
      await verifyProtectedSurfaces(options.projectRoot, protectedSurfaces);
      if (hashBundle(await collectRegularFiles(baselineTarget)) !== enrollmentRevision.bundleSha256) {
        fail(500, 'FOLDY_POINTER_PARITY_FAILED', 'installed legacy baseline bundle parity failed');
      }

      return {
        ok: true,
        projectId: options.projectId,
        currentRevisionId: authoritativeCurrent,
        workbookId: legacyWorkbook.workbookId,
        sourceWorkbookPath,
        baselineBundleSha256: enrollmentRevision.bundleSha256,
        controlManifestSha256: protectedSurfaces[0]!.sha256,
        rootPointerParityVerified: true,
        protectedSurfacesEnrolled: protectedSurfaces.length,
        candidateTouched: false,
        atomicity: 'project-locked staged baseline install with metadata compare-and-set and rollback',
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (metadataUpdated) {
        try {
          if (!await options.compareAndSetProjectMetadata(enrolledMetadata, metadata)) {
            rollbackErrors.push('metadata: compare-and-set rejected rollback');
          }
        } catch (rollbackError) {
          rollbackErrors.push(`metadata: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      try {
        if (controlInstalled) await rm(controlTarget, { force: true });
        if (baselineInstalled) await rm(baselineTarget, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`filesystem: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      if (rollbackErrors.length > 0) {
        fail(500, 'FOLDY_ROLLBACK_FAILED', 'legacy Foldy enrollment failed and rollback did not complete', {
          rollbackErrors,
          originalError: error instanceof FoldyPromotionError ? error.code : error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function repairFoldyNoProtectedAncestor(
  options: RepairFoldyNoProtectedAncestorOptions,
): Promise<Record<string, unknown>> {
  return withFoldyProjectLock(options.projectId, async () => {
    const request = parseFoldyNoProtectedAncestorRepairRequest(options.projectId, options.request);
    const metadata = await options.readProjectMetadata();
    if (!metadata) fail(404, 'FOLDY_PROJECT_NOT_FOUND', 'project disappeared during Foldy baseline repair');
    const authoritativeCurrent = currentRevision(metadata);
    const controlLogicalPath = '.foldy-protected-surface-control.json';
    const controlTarget = await assertContainedPath(options.projectRoot, controlLogicalPath);
    const existingControl = await readFile(controlTarget).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });

    // The exact same request is a safe replay after a successful response was lost.
    if (authoritativeCurrent === request.repairRevisionId && existingControl) {
      const parsed = JSON.parse(existingControl.toString('utf8')) as Record<string, unknown>;
      if (parsed.version === 'foldy-no-protected-ancestor-control.v1'
        && parsed.projectId === options.projectId
        && parsed.priorRevisionId === request.expectedCurrentRevisionId
        && parsed.repairRevisionId === request.repairRevisionId
        && parsed.dedupKey === request.dedupKey) {
        const baseline = await loadAuthoritativeProtectedManifest(options.projectRoot, request.repairRevisionId, metadata);
        await verifyProtectedSurfaces(options.projectRoot, baseline.surfaces);
        return {
          ok: true, idempotent: true, projectId: options.projectId,
          priorRevisionId: request.expectedCurrentRevisionId,
          currentRevisionId: request.repairRevisionId,
          workbookId: baseline.workbookId,
          protectedManifestSha256: hashProtectedSurfaceContract(baseline.surfaces),
          rootPointerParityVerified: true, candidateTouched: false,
        };
      }
      fail(409, 'FOLDY_BASELINE_REPAIR_ALREADY_APPLIED', 'a different Foldy baseline repair is already installed');
    }
    if (authoritativeCurrent !== request.expectedCurrentRevisionId) {
      fail(409, 'FOLDY_STALE_CURRENT', 'expected current revision does not match project envelope');
    }
    if (!authoritativeCurrent) {
      fail(409, 'FOLDY_BASELINE_REPAIR_NOT_APPLICABLE', 'legacy enrollment must be used before repairing an established lineage');
    }
    if (existingControl) fail(409, 'FOLDY_BASELINE_REPAIR_ALREADY_APPLIED', 'Foldy protected-surface control already exists');

    const entryFile = typeof metadata.entryFile === 'string' ? safeLogicalPath(metadata.entryFile, 'metadata.entryFile') : 'index.html';
    const rootFiles = [REQUIRED_POINTER_FILE, entryFile, `${entryFile}.artifact.json`];
    const priorRoot = new Map<string, Buffer>();
    for (const logicalPath of rootFiles) priorRoot.set(logicalPath, await regularFileBytes(options.projectRoot, logicalPath));
    let workbook: Record<string, unknown>;
    try {
      workbook = JSON.parse(priorRoot.get(REQUIRED_POINTER_FILE)!.toString('utf8')) as Record<string, unknown>;
    } catch {
      fail(422, 'FOLDY_BASELINE_REPAIR_INVALID', 'current workbook.json is not valid JSON');
    }
    if (!isPlainObject(workbook) || typeof workbook.workbookId !== 'string' || !ID.test(workbook.workbookId)
      || !Array.isArray(workbook.revisions) || workbook.revisions.length === 0) {
      fail(422, 'FOLDY_BASELINE_REPAIR_INVALID', 'current workbook lineage is missing or invalid');
    }
    if (metadata.workbookId !== workbook.workbookId) fail(409, 'FOLDY_WORKBOOK_IDENTITY_MISMATCH', 'current workbook does not match project envelope');
    if (!workbook.revisions.some((item) => isPlainObject(item) && item.revisionId === authoritativeCurrent)) {
      fail(422, 'FOLDY_BASELINE_REPAIR_INVALID', 'current revision is absent from workbook lineage');
    }
    if (workbook.revisions.some((item) => isPlainObject(item) && Array.isArray(item.protectedSurfaces) && item.protectedSurfaces.length > 0)) {
      fail(409, 'FOLDY_PROTECTED_ANCESTOR_EXISTS', 'lineage already has a protected ancestor');
    }
    if (workbook.revisions.some((item) => isPlainObject(item) && item.revisionId === request.repairRevisionId)) {
      fail(409, 'FOLDY_REPAIR_REVISION_EXISTS', 'repair revision already exists in workbook lineage');
    }

    const repairLogicalPath = `revisions/${request.repairRevisionId}`;
    const repairTarget = await assertContainedPath(options.projectRoot, repairLogicalPath);
    if (await lstat(repairTarget).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))) {
      fail(409, 'FOLDY_REPAIR_REVISION_EXISTS', 'repair revision directory already exists');
    }
    const controlBytes = Buffer.from(JSON.stringify({
      version: 'foldy-no-protected-ancestor-control.v1', projectId: options.projectId,
      workbookId: workbook.workbookId, priorRevisionId: authoritativeCurrent,
      repairRevisionId: request.repairRevisionId, dedupKey: request.dedupKey, entryFile,
      priorRootFiles: rootFiles.map((logicalPath) => ({ path: logicalPath, sha256: sha256(priorRoot.get(logicalPath)!) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    }), 'utf8');
    const protectedSurfaces = [{ path: controlLogicalPath, sha256: sha256(controlBytes) }];
    const repairWorkbook = structuredClone(workbook);
    repairWorkbook.revisions = [...workbook.revisions, {
      revisionId: request.repairRevisionId, parentRevisionId: authoritativeCurrent,
      state: 'FROZEN', bundleSha256: null, protectedSurfaces,
    }];
    const repairEntry = (repairWorkbook.revisions as Record<string, unknown>[]).at(-1)!;
    const repairedMetadata = { ...metadata, foldy: true, workbookId: workbook.workbookId,
      revisionId: request.repairRevisionId, currentRevisionId: request.repairRevisionId, entryFile };
    const stagingRoot = path.join(await realpath(options.projectRoot), `.foldy-baseline-repair-${randomUUID()}`);
    const stagedRevision = path.join(stagingRoot, 'revision');
    let revisionInstalled = false;
    let controlInstalled = false;
    let rootWorkbookInstalled = false;
    let metadataUpdated = false;
    await mkdir(stagedRevision, { recursive: true });
    try {
      await mkdir(path.dirname(path.join(stagedRevision, entryFile)), { recursive: true });
      await writeFile(path.join(stagedRevision, entryFile), priorRoot.get(entryFile)!);
      await mkdir(path.dirname(path.join(stagedRevision, `${entryFile}.artifact.json`)), { recursive: true });
      await writeFile(path.join(stagedRevision, `${entryFile}.artifact.json`), priorRoot.get(`${entryFile}.artifact.json`)!);
      const stagedWorkbook = path.join(stagedRevision, REQUIRED_POINTER_FILE);
      await writeFile(stagedWorkbook, JSON.stringify(repairWorkbook));
      repairEntry.bundleSha256 = hashBundle(await collectRegularFiles(stagedRevision));
      await writeFile(stagedWorkbook, JSON.stringify(repairWorkbook));
      await mkdir(path.dirname(repairTarget), { recursive: true });
      await rename(stagedRevision, repairTarget);
      revisionInstalled = true;
      await writeFile(controlTarget, controlBytes, { flag: 'wx' });
      controlInstalled = true;
      await writeFile(await assertContainedPath(options.projectRoot, REQUIRED_POINTER_FILE), await readFile(path.join(repairTarget, REQUIRED_POINTER_FILE)));
      rootWorkbookInstalled = true;
      if (!await options.compareAndSetProjectMetadata(metadata, repairedMetadata)) fail(409, 'FOLDY_METADATA_CAS_FAILED', 'project metadata changed during Foldy baseline repair');
      metadataUpdated = true;
      for (const logicalPath of rootFiles) {
        if (sha256(await regularFileBytes(options.projectRoot, logicalPath)) !== sha256(await regularFileBytes(repairTarget, logicalPath))) {
          fail(500, 'FOLDY_POINTER_PARITY_FAILED', `repaired root pointer parity failed: ${logicalPath}`);
        }
      }
      await verifyProtectedSurfaces(options.projectRoot, protectedSurfaces);
      return {
        ok: true, idempotent: false, projectId: options.projectId,
        priorRevisionId: authoritativeCurrent, currentRevisionId: request.repairRevisionId,
        workbookId: workbook.workbookId, repairBundleSha256: repairEntry.bundleSha256,
        protectedManifestSha256: hashProtectedSurfaceContract(protectedSurfaces),
        rootPointerParityVerified: true, protectedSurfacesEnrolled: 1, candidateTouched: false,
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (metadataUpdated && !await options.compareAndSetProjectMetadata(repairedMetadata, metadata)) rollbackErrors.push('metadata CAS rollback rejected');
      try {
        if (rootWorkbookInstalled) await writeFile(await assertContainedPath(options.projectRoot, REQUIRED_POINTER_FILE), priorRoot.get(REQUIRED_POINTER_FILE)!);
        if (controlInstalled) await rm(controlTarget, { force: true });
        if (revisionInstalled) await rm(repairTarget, { recursive: true, force: true });
      } catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
      if (rollbackErrors.length) fail(500, 'FOLDY_ROLLBACK_FAILED', 'Foldy baseline repair rollback failed', { rollbackErrors });
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function promoteFoldy(options: PromoteFoldyOptions): Promise<Record<string, unknown>> {
  return withFoldyProjectLock(options.projectId, async () => {
    const request = parseFoldyPromotionRequest(options.projectId, options.request);
    const metadata = await options.readProjectMetadata();
    if (!metadata) fail(404, 'FOLDY_PROJECT_NOT_FOUND', 'project disappeared during Foldy promotion');
    const authoritativeCurrent = currentRevision(metadata);
    if (authoritativeCurrent !== request.expectedCurrentRevisionId) {
      fail(409, 'FOLDY_STALE_CURRENT', 'expected current revision does not match project envelope', {
        expectedCurrentRevisionId: request.expectedCurrentRevisionId,
        actualCurrentRevisionId: authoritativeCurrent,
      });
    }

    const baseline = await loadAuthoritativeProtectedManifest(options.projectRoot, authoritativeCurrent, metadata);
    const authoritativeManifestHash = hashProtectedSurfaceContract(baseline.surfaces);
    if (hashProtectedSurfaceContract(request.protectedSurfaces) !== authoritativeManifestHash) {
      fail(422, 'FOLDY_PROTECTED_BASELINE_MISMATCH', 'request protectedSurfaces does not match the frozen server-side baseline');
    }
    await verifyProtectedSurfaces(options.projectRoot, baseline.surfaces);

    const candidateLogicalRoot = `revisions/${request.candidateRevisionId}`;
    const candidateRoot = await assertContainedPath(options.projectRoot, candidateLogicalRoot);
    const candidateFiles = await collectRegularFiles(candidateRoot);
    const bundleBefore = hashBundle(candidateFiles);
    if (bundleBefore !== request.candidateBundleSha256) {
      fail(422, 'FOLDY_CANDIDATE_HASH_MISMATCH', 'candidate directory does not match candidateBundleSha256');
    }
    const byPath = new Map(candidateFiles.map((file) => [file.path, file.bytes]));
    for (const logicalPath of request.rootFiles) {
      if (!byPath.has(logicalPath)) fail(422, 'FOLDY_CANDIDATE_INCOMPLETE', `candidate lacks root file: ${logicalPath}`);
    }
    const candidateIdentity = validateCandidateWorkbook(byPath.get(REQUIRED_POINTER_FILE)!, request);
    if (candidateIdentity.workbookId !== baseline.workbookId) {
      fail(422, 'FOLDY_WORKBOOK_IDENTITY_MISMATCH', 'candidate workbook does not match protected baseline workbook');
    }
    const receiptBindings = {
      project_id: options.projectId,
      workbook_id: baseline.workbookId,
      baseline_revision_id: authoritativeCurrent,
      candidate_revision_id: request.candidateRevisionId,
      contract: {
        version: 'foldy-promotion.v1' as const,
        entry_file: request.entryFile,
        root_files: request.rootFiles,
      },
      bundle_sha256: request.candidateBundleSha256,
      protected_manifest_sha256: authoritativeManifestHash,
    };
    assertConfiguredReceiptKeysAreIndependent();
    verifyReceipt(request.wrenReceipt, 'foldy-wren-review.v1', receiptBindings);
    verifyReceipt(request.assuranceReceipt, 'foldy-assurance.v1', receiptBindings);

    const transactionId = randomUUID();
    const projectReal = await realpath(options.projectRoot);
    const stagingRoot = path.join(projectReal, `.foldy-promotion-${transactionId}`);
    const backups = new Map<string, Buffer | null>();
    const promotedMetadata: FoldyProjectMetadata = {
      ...metadata,
      workbookId: candidateIdentity.workbookId,
      revisionId: request.candidateRevisionId,
      currentRevisionId: request.candidateRevisionId,
      entryFile: request.entryFile,
      foldy: true,
    };
    let metadataUpdated = false;
    await mkdir(stagingRoot, { recursive: false });
    try {
      for (const logicalPath of request.rootFiles) {
        await assertContainedPath(options.projectRoot, logicalPath);
        const staged = path.join(stagingRoot, ...logicalPath.split('/'));
        await mkdir(path.dirname(staged), { recursive: true });
        await writeFile(staged, byPath.get(logicalPath)!);
        if (sha256(await readFile(staged)) !== sha256(byPath.get(logicalPath)!)) {
          fail(500, 'FOLDY_STAGE_PARITY_FAILED', `staged byte parity failed: ${logicalPath}`);
        }
      }

      for (const logicalPath of request.rootFiles) {
        let target = await assertContainedPath(options.projectRoot, logicalPath);
        const prior = await readFile(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        backups.set(logicalPath, prior);
        target = await assertContainedPath(options.projectRoot, logicalPath);
        await mkdir(path.dirname(target), { recursive: true });
        target = await assertContainedPath(options.projectRoot, logicalPath);
        await rename(path.join(stagingRoot, ...logicalPath.split('/')), target);
        await options.hooks?.afterRootWrite?.(logicalPath);
      }

      if (!await options.compareAndSetProjectMetadata(metadata, promotedMetadata)) {
        fail(409, 'FOLDY_METADATA_CAS_FAILED', 'project metadata changed during Foldy promotion');
      }
      metadataUpdated = true;

      for (const logicalPath of request.rootFiles) {
        const actual = await regularFileBytes(options.projectRoot, logicalPath);
        if (sha256(actual) !== sha256(byPath.get(logicalPath)!)) {
          fail(500, 'FOLDY_POINTER_PARITY_FAILED', `root pointer byte parity failed: ${logicalPath}`);
        }
      }
      await verifyProtectedSurfaces(options.projectRoot, baseline.surfaces);
      const candidateAfter = hashBundle(await collectRegularFiles(candidateRoot));
      if (candidateAfter !== bundleBefore) {
        fail(500, 'FOLDY_CANDIDATE_MUTATED', 'candidate revision changed during promotion');
      }

      return {
        ok: true,
        projectId: options.projectId,
        priorRevisionId: request.expectedCurrentRevisionId,
        currentRevisionId: request.candidateRevisionId,
        workbookId: candidateIdentity.workbookId,
        candidateBundleSha256: request.candidateBundleSha256,
        pointerParityVerified: true,
        protectedSurfacesVerified: baseline.surfaces.length,
        candidateImmutable: true,
        atomicity: 'project-locked staged file replacement with metadata compare-and-set and explicit rollback failure reporting',
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      try {
        await options.hooks?.beforeRollbackRestore?.();
        await restoreRootFiles(options.projectRoot, backups);
      } catch (rollbackError) {
        rollbackErrors.push(`filesystem: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      if (metadataUpdated) {
        try {
          if (!await options.compareAndSetProjectMetadata(promotedMetadata, metadata)) {
            rollbackErrors.push('metadata: compare-and-set rejected rollback');
          }
        } catch (rollbackError) {
          rollbackErrors.push(`metadata: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        fail(500, 'FOLDY_ROLLBACK_FAILED', 'Foldy promotion failed and rollback did not complete', {
          rollbackErrors,
          originalError: error instanceof FoldyPromotionError ? error.code : error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function isFoldyProject(projectRoot: string, metadata?: FoldyProjectMetadata | null): Promise<boolean> {
  if (metadata?.foldy === true || typeof metadata?.workbookId === 'string' || currentRevision(metadata ?? {}) !== null) {
    return true;
  }
  try {
    const parsed = JSON.parse((await readFile(path.join(projectRoot, REQUIRED_POINTER_FILE), 'utf8')) as string) as unknown;
    return isPlainObject(parsed) && typeof parsed.workbookId === 'string' && Array.isArray(parsed.revisions);
  } catch {
    return false;
  }
}

export function foldyPointerPaths(metadata?: FoldyProjectMetadata | null): Set<string> {
  const entryFile = typeof metadata?.entryFile === 'string' ? safeLogicalPath(metadata.entryFile, 'metadata.entryFile') : 'index.html';
  return new Set([REQUIRED_POINTER_FILE, entryFile, `${entryFile}.artifact.json`]);
}

const FOLDY_ENROLLMENT_METADATA_KEYS = [
  'foldy',
  'workbookId',
  'revisionId',
  'currentRevisionId',
] as const;

export function assertGenericFoldyProjectCreationAllowed(metadata: unknown): void {
  if (!isPlainObject(metadata)) return;
  const enrollmentField = FOLDY_ENROLLMENT_METADATA_KEYS.find((key) =>
    Object.prototype.hasOwnProperty.call(metadata, key));
  if (enrollmentField) {
    fail(
      409,
      'FOLDY_PROMOTION_REQUIRED',
      `Foldy enrollment field metadata.${enrollmentField} is not allowed through generic project creation`,
    );
  }
}

export async function assertGenericFoldyFileMutationAllowed(input: {
  projectRoot: string;
  metadata?: FoldyProjectMetadata | null;
  logicalPath: string;
  operation: 'write' | 'rename' | 'delete';
  destinationPath?: string;
  incomingBytes?: Buffer;
}): Promise<{ forceCreateOnly: boolean }> {
  const logicalPath = safeLogicalPath(input.logicalPath, 'file path');
  const destinationPath = input.destinationPath === undefined
    ? undefined
    : safeLogicalPath(input.destinationPath, 'destination path');
  const foldy = await isFoldyProject(input.projectRoot, input.metadata);
  if (!foldy) {
    const workbookTarget = input.operation === 'write'
      ? logicalPath === REQUIRED_POINTER_FILE
      : destinationPath === REQUIRED_POINTER_FILE;
    if (workbookTarget && input.operation === 'rename') {
      fail(409, 'FOLDY_PROMOTION_REQUIRED', 'workbook.json cannot be created through generic rename');
    }
    if (workbookTarget && input.incomingBytes) {
      try {
        const candidate = JSON.parse(input.incomingBytes.toString('utf8')) as unknown;
        if (isPlainObject(candidate) && typeof candidate.workbookId === 'string' && Array.isArray(candidate.revisions)) {
          fail(409, 'FOLDY_PROMOTION_REQUIRED', 'Foldy projects cannot be enrolled through generic file mutation');
        }
      } catch (error) {
        if (error instanceof FoldyPromotionError) throw error;
      }
    }
    return { forceCreateOnly: false };
  }
  const pointers = foldyPointerPaths(input.metadata);
  if (pointers.has(logicalPath) || (destinationPath && pointers.has(destinationPath))) {
    fail(409, 'FOLDY_PROMOTION_REQUIRED', 'Foldy root pointers may only change through POST /api/projects/:id/foldy/promote');
  }
  if (logicalPath.startsWith('revisions/') || destinationPath?.startsWith('revisions/')) {
    if (input.operation !== 'write' || destinationPath) {
      fail(409, 'FOLDY_REVISION_IMMUTABLE', 'Foldy revision files are immutable after staging');
    }
    return { forceCreateOnly: true };
  }
  return { forceCreateOnly: false };
}

export async function withGenericFoldyFileMutation<T>(input: {
  projectId: string;
  projectRoot: string;
  readProjectMetadata: () => Promise<FoldyProjectMetadata | null | undefined> | FoldyProjectMetadata | null | undefined;
  logicalPath: string;
  operation: 'write' | 'rename' | 'delete';
  destinationPath?: string;
  incomingBytes?: Buffer;
  mutate: (guard: { forceCreateOnly: boolean }, metadata: FoldyProjectMetadata | null | undefined) => Promise<T>;
}): Promise<T> {
  return withFoldyProjectLock(input.projectId, async () => {
    const metadata = await input.readProjectMetadata();
    const guard = await assertGenericFoldyFileMutationAllowed({
      projectRoot: input.projectRoot,
      ...(metadata === undefined ? {} : { metadata }),
      logicalPath: input.logicalPath,
      operation: input.operation,
      ...(input.destinationPath === undefined ? {} : { destinationPath: input.destinationPath }),
      ...(input.incomingBytes === undefined ? {} : { incomingBytes: input.incomingBytes }),
    });
    await assertContainedPath(input.projectRoot, safeLogicalPath(input.logicalPath, 'file path'));
    if (input.destinationPath !== undefined) {
      await assertContainedPath(input.projectRoot, safeLogicalPath(input.destinationPath, 'destination path'));
    }
    return input.mutate(guard, metadata);
  });
}

export async function assertGenericFoldyMetadataPatchAllowed(
  projectRoot: string,
  existingMetadata: FoldyProjectMetadata | null | undefined,
  incomingMetadata: unknown,
): Promise<void> {
  const existingIsFoldy = await isFoldyProject(projectRoot, existingMetadata);
  if (!isPlainObject(incomingMetadata)) {
    if (existingIsFoldy) {
      fail(409, 'FOLDY_PROMOTION_REQUIRED', 'Foldy project metadata must remain an object outside promotion');
    }
    return;
  }
  const enrollmentRequested = incomingMetadata.foldy === true
    || typeof incomingMetadata.workbookId === 'string'
    || typeof incomingMetadata.revisionId === 'string'
    || typeof incomingMetadata.currentRevisionId === 'string';
  if (!existingIsFoldy) {
    if (enrollmentRequested) {
      fail(409, 'FOLDY_PROMOTION_REQUIRED', 'Foldy projects cannot be enrolled through generic metadata PATCH');
    }
    return;
  }
  const immutableEnvelopeKeys = ['foldy', 'workbookId', 'revisionId', 'currentRevisionId', 'entryFile'] as const;
  for (const key of immutableEnvelopeKeys) {
    if (!Object.prototype.hasOwnProperty.call(incomingMetadata, key) || incomingMetadata[key] !== existingMetadata?.[key]) {
      fail(409, 'FOLDY_PROMOTION_REQUIRED', `Foldy project ${key} metadata is immutable outside POST /api/projects/:id/foldy/promote`);
    }
  }
}
