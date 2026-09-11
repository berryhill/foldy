import type {
  FoldyPublicationProjectState,
  FoldyPublicationTransition,
  FoldyPublishedRevision,
  FoldyReviewComment,
  FoldyReviewDecision,
  FoldyReviewRecord,
  FoldyRevisionFile,
  FoldyRevisionRecord,
  FoldyRevisionSummary,
} from '@open-design/contracts';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { withFoldyProjectLock } from '../foldy-promotion.js';
import { setTimeout as delay } from 'node:timers/promises';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const EXCLUDED_PATH_SEGMENTS = new Set(['.od', '.git', 'node_modules', 'src', 'source', 'build']);
const EXCLUDED_FILE_NAMES = new Set([
  '.env', 'credentials', 'credentials.json', 'package.json', 'package-lock.json',
  'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'vite.config.ts',
]);
const DEFAULT_SNAPSHOT_LIMITS = {
  maxDepth: 32,
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
} as const;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;
const DEAD_LOCK_GRACE_MS = 1_000;
const MALFORMED_LOCK_STALE_MS = 30_000;
const RECEIPT_TEMP_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FoldySnapshotLimits {
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

interface ResolvedSnapshotLimits {
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/** @internal Deterministic race seams used only by the storage security tests. */
interface FoldyPublicationStoreTestHooks {
  beforeStorageCommit?: (operation: 'replace' | 'create', target: string) => void | Promise<void>;
  beforeSnapshotFileOpen?: (projectRoot: string, relativePath: string) => void | Promise<void>;
  beforeStorageMutation?: (
    operation: 'mkdir' | 'lock-acquire' | 'lock-recover' | 'lock-release' | 'receipt-temp-cleanup',
    target: string,
  ) => void | Promise<void>;
}

export interface SaveFoldyRevisionInput {
  projectId: string;
  projectRoot: string;
  entryFile: string;
  expectedLatestRevisionId: string | null;
  actorId: string;
  /** Exact public files. Omission intentionally includes only the enrolled entry. */
  publicationFiles?: readonly string[];
}

export interface RequestFoldyReviewInput {
  projectId: string;
  revisionId: string;
  expectedLatestRevisionId: string;
  actorId: string;
}

export interface AddFoldyReviewCommentInput {
  projectId: string;
  revisionId: string;
  reviewId: string;
  body: string;
  expectedReviewVersion: number;
  actorId: string;
}

export interface DecideFoldyReviewInput {
  projectId: string;
  revisionId: string;
  reviewId: string;
  decision: FoldyReviewDecision;
  expectedReviewVersion: number;
  actorId: string;
}

export interface PublishFoldyRevisionInput {
  projectId: string;
  revisionId: string;
  expectedPublishedGeneration: number;
  actorId: string;
}

export interface RollbackFoldyPublicationInput {
  projectId: string;
  targetRevisionId: string;
  expectedPublishedGeneration: number;
  actorId: string;
}

export interface FoldyResolvedFile {
  projectId: string;
  revisionId: string;
  path: string;
  sha256: string;
  size: number;
  bytes: Buffer;
}

export class FoldyPublicationStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 422 | 500,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'FoldyPublicationStoreError';
  }
}

interface MutableState extends Omit<FoldyPublicationProjectState, 'revisions' | 'reviews' | 'transitions'> {
  revisions: FoldyRevisionSummary[];
  reviews: FoldyReviewRecord[];
  transitions: FoldyPublicationTransition[];
}

function fail(
  status: FoldyPublicationStoreError['status'],
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new FoldyPublicationStoreError(code, message, status, details);
}

function validateId(value: string, kind: 'project' | 'revision' | 'review' | 'comment' | 'transition' | 'actor'): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value === '.' || value === '..') {
    const code = kind === 'project' ? 'FOLDY_INVALID_PROJECT_ID' : `FOLDY_INVALID_${kind.toUpperCase()}_ID`;
    fail(400, code, `invalid Foldy ${kind} id`);
  }
  return value;
}

function validateGeneration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'FOLDY_INVALID_CAS', `${field} must be a non-negative safe integer`);
  return value;
}

function validatePositiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'FOLDY_INVALID_SNAPSHOT_LIMIT', `${field} must be a positive safe integer`);
  return value;
}

function logicalPath(value: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === '.'
    || value.startsWith('../')) {
    fail(400, 'FOLDY_INVALID_PATH', 'path must be a normalized project-relative POSIX path');
  }
  return value;
}

function iso(now: () => Date): string {
  const date = now();
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) fail(500, 'FOLDY_CLOCK_INVALID', 'store clock returned an invalid date');
  return date.toISOString();
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function emptyState(projectId: string): MutableState {
  return {
    schemaVersion: 1,
    projectId,
    latestRevisionId: null,
    publishedRevisionId: null,
    publishedGeneration: 0,
    revisions: [],
    reviews: [],
    activeReview: null,
    transitions: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function rejectSymlink(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy storage contains a symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function storageRelative(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy path escaped its storage root');
  }
  return relative;
}

async function ensureDurableDirectory(
  target: string,
  testHooks?: FoldyPublicationStoreTestHooks,
): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const fence = await openDescriptorFence(parsed.root, parsed.root);
  let current = parsed.root;
  try {
    for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const parent = fence.at(-1)!;
      const parentHandle = parent.handle;
      const anchored = descriptorPath(parent, component);
      let stat = await lstat(anchored).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) {
        await testHooks?.beforeStorageMutation?.('mkdir', current);
        try {
          await mkdir(anchored);
          await parentHandle.sync();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        stat = await lstat(anchored);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy directory is not a regular directory');
      }
      const handle = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (!actual.isDirectory() || actual.dev !== stat.dev || actual.ino !== stat.ino) {
        await handle.close();
        fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy path changed identity while being opened');
      }
      fence.push({ path: current, dev: actual.dev, ino: actual.ino, handle });
    }
    await assertDescriptorFence(fence);
  } finally {
    await closeDescriptorFence(fence);
  }
}

async function mkdirStorageDirectory(
  root: string,
  target: string,
  testHooks?: FoldyPublicationStoreTestHooks,
): Promise<void> {
  storageRelative(root, target);
  await ensureDurableDirectory(target, testHooks);
}

async function requireRegularFile(target: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    throw error;
  }
  if (stat.isSymbolicLink()) fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy storage contains a symlink');
  if (!stat.isFile()) fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy file is not a regular file');
}

interface DescriptorFenceEntry extends FileIdentity {
  handle: FileHandle;
}

export type FoldyStorageAccessKind = 'linux-descriptor-relative' | 'darwin-identity-fenced';

/** @internal Exported so platform dispatch can be tested without replacing process.platform. */
export function foldyStorageAccessKind(platform: NodeJS.Platform): FoldyStorageAccessKind {
  if (platform === 'linux') return 'linux-descriptor-relative';
  if (platform === 'darwin') return 'darwin-identity-fenced';
  fail(500, 'FOLDY_UNSAFE_STORAGE', 'secure filesystem access is unavailable on this platform');
}

/** @internal Exported so path selection can be tested without a live descriptor. */
export function foldyStorageAccessPath(
  platform: NodeJS.Platform,
  anchor: { path: string; fd: number },
  child?: string,
): string {
  const kind = foldyStorageAccessKind(platform);
  // Linux retains the stronger descriptor-relative boundary: procfs resolves
  // children from the already-open directory even if its pathname is replaced.
  // Darwin has no reliable Node renameat/linkat or descriptor-relative child
  // path. It therefore uses the canonical path while open descriptor + path
  // dev/inode fences are checked around access and mutation. This detects
  // replacement and prevents the result from being admitted as store state,
  // but unlike Linux it does not claim to prevent every attempted write by a
  // same-user process racing inside the narrow interval between fence checks.
  const base = kind === 'linux-descriptor-relative' ? `/proc/self/fd/${anchor.fd}` : anchor.path;
  return child === undefined ? base : path.join(base, child);
}

function descriptorPath(entry: DescriptorFenceEntry, child?: string): string {
  return foldyStorageAccessPath(process.platform, { path: entry.path, fd: entry.handle.fd }, child);
}

async function openDescriptorFence(root: string, target: string): Promise<DescriptorFenceEntry[]> {
  const relative = storageRelative(root, target);
  const entries: DescriptorFenceEntry[] = [];
  let currentPath = root;
  try {
    for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
      const openedPath = component === '' ? currentPath : descriptorPath(entries.at(-1)!, component);
      if (component !== '') currentPath = path.join(currentPath, component);
      const expected = await lstat(openedPath);
      if (expected.isSymbolicLink() || !expected.isDirectory()) {
        fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy directory is not a regular directory');
      }
      const handle = await open(openedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
        await handle.close();
        fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy path changed identity while being opened');
      }
      entries.push({ path: currentPath, dev: actual.dev, ino: actual.ino, handle });
    }
    await assertDescriptorFence(entries);
    return entries;
  } catch (error) {
    await Promise.all(entries.map((entry) => entry.handle.close()));
    throw error;
  }
}

async function assertDescriptorFence(entries: DescriptorFenceEntry[]): Promise<void> {
  for (const entry of entries) {
    const [pathStat, descriptorStat] = await Promise.all([
      lstat(entry.path).catch(() => null),
      entry.handle.stat().catch(() => null),
    ]);
    if (!pathStat || !descriptorStat || pathStat.isSymbolicLink() || !pathStat.isDirectory()
      || pathStat.dev !== entry.dev || pathStat.ino !== entry.ino
      || descriptorStat.dev !== entry.dev || descriptorStat.ino !== entry.ino) {
      fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy path changed identity during access');
    }
  }
}

async function closeDescriptorFence(entries: DescriptorFenceEntry[]): Promise<void> {
  await Promise.all(entries.map((entry) => entry.handle.close()));
}

async function captureOptionalIdentity(target: string): Promise<FileIdentity | null> {
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy file is not a regular file');
  return { path: target, dev: stat.dev, ino: stat.ino };
}

async function assertOptionalIdentity(target: string, expected: FileIdentity | null): Promise<void> {
  const actual = await captureOptionalIdentity(target);
  if ((expected === null) !== (actual === null)
    || (expected && actual && (expected.dev !== actual.dev || expected.ino !== actual.ino))) {
    fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy file changed identity during access');
  }
}

async function atomicReplaceJson(
  root: string,
  target: string,
  value: unknown,
  testHooks?: FoldyPublicationStoreTestHooks,
): Promise<void> {
  const directory = path.dirname(target);
  await mkdirStorageDirectory(root, directory, testHooks);
  const directoryFence = await openDescriptorFence(root, directory);
  const directoryEntry = directoryFence.at(-1)!;
  const directoryHandle = directoryEntry.handle;
  const targetName = path.basename(target);
  const secureTarget = descriptorPath(directoryEntry, targetName);
  const targetIdentity = await captureOptionalIdentity(secureTarget);
  const tempName = `.${targetName}.${process.pid}.${randomUUID()}.tmp`;
  const secureTemp = descriptorPath(directoryEntry, tempName);
  let handle: FileHandle | undefined;
  try {
    handle = await open(secureTemp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await testHooks?.beforeStorageCommit?.('replace', target);
    const [descriptorStat, tempStat] = await Promise.all([handle.stat(), lstat(secureTemp)]);
    if (!descriptorStat.isFile() || descriptorStat.dev !== tempStat.dev || descriptorStat.ino !== tempStat.ino) {
      fail(500, 'FOLDY_UNSAFE_STORAGE', 'staged Foldy file changed identity before commit');
    }
    await assertDescriptorFence(directoryFence);
    await assertOptionalIdentity(secureTarget, targetIdentity);
    await rename(secureTemp, secureTarget);
    await directoryHandle.sync();
    await assertDescriptorFence(directoryFence);
    await assertOptionalIdentity(secureTarget, { path: secureTarget, dev: descriptorStat.dev, ino: descriptorStat.ino });
  } finally {
    await handle?.close();
    await rm(secureTemp, { force: true });
    await closeDescriptorFence(directoryFence);
  }
}

async function createImmutableFile(
  root: string,
  target: string,
  bytes: Buffer,
  testHooks?: FoldyPublicationStoreTestHooks,
): Promise<boolean> {
  const directory = path.dirname(target);
  await mkdirStorageDirectory(root, directory, testHooks);
  const directoryFence = await openDescriptorFence(root, directory);
  const directoryEntry = directoryFence.at(-1)!;
  const directoryHandle = directoryEntry.handle;
  const targetName = path.basename(target);
  const secureTarget = descriptorPath(directoryEntry, targetName);
  const targetIdentity = await captureOptionalIdentity(secureTarget);
  const tempName = `.${targetName}.${process.pid}.${randomUUID()}.tmp`;
  const secureTemp = descriptorPath(directoryEntry, tempName);
  let handle: FileHandle | undefined;
  try {
    handle = await open(secureTemp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await testHooks?.beforeStorageCommit?.('create', target);
    const [descriptorStat, tempStat] = await Promise.all([handle.stat(), lstat(secureTemp)]);
    if (!descriptorStat.isFile() || descriptorStat.dev !== tempStat.dev || descriptorStat.ino !== tempStat.ino) {
      fail(500, 'FOLDY_UNSAFE_STORAGE', 'staged Foldy file changed identity before commit');
    }
    await assertDescriptorFence(directoryFence);
    await assertOptionalIdentity(secureTarget, targetIdentity);
    try {
      await link(secureTemp, secureTarget);
      await directoryHandle.sync();
      await assertDescriptorFence(directoryFence);
      await assertOptionalIdentity(secureTarget, { path: secureTarget, dev: descriptorStat.dev, ino: descriptorStat.ino });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await requireRegularFile(secureTarget);
      await assertDescriptorFence(directoryFence);
      return false;
    }
  } finally {
    await handle?.close();
    await rm(secureTemp, { force: true });
    await closeDescriptorFence(directoryFence);
  }
}

interface FileIdentity {
  path: string;
  dev: number;
  ino: number;
}

async function captureStorageFence(root: string, target: string): Promise<FileIdentity[]> {
  const relative = storageRelative(root, target);
  const identities: FileIdentity[] = [];
  let current = root;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy storage contains a symlink');
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function assertStorageFence(identities: FileIdentity[]): Promise<void> {
  for (const identity of identities) {
    const stat = await lstat(identity.path).catch(() => null);
    if (!stat || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      fail(500, 'FOLDY_UNSAFE_STORAGE', 'daemon-owned Foldy path changed identity during access');
    }
  }
}

async function readRegularNoFollow(
  target: string,
  options: { storageRoot?: string; maxBytes: number; expectedSize?: number; tooLargeCode?: string },
): Promise<Buffer> {
  const fence = options.storageRoot ? await captureStorageFence(options.storageRoot, target) : [];
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail(500, 'FOLDY_UNSAFE_STORAGE', 'refused to follow a symlink');
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail(500, 'FOLDY_UNSAFE_STORAGE', 'expected a regular file');
    const pathIdentity = fence.at(-1);
    if (pathIdentity && (before.dev !== pathIdentity.dev || before.ino !== pathIdentity.ino)) {
      fail(500, 'FOLDY_UNSAFE_STORAGE', 'opened file identity did not match the validated storage path');
    }
    if (!Number.isSafeInteger(before.size) || before.size > options.maxBytes
      || (options.expectedSize !== undefined && before.size !== options.expectedSize)) {
      fail(500, options.tooLargeCode ?? 'FOLDY_STORAGE_SIZE_INVALID', 'daemon-owned Foldy file has an unexpected size');
    }
    const bound = options.expectedSize ?? before.size;
    const bytes = Buffer.allocUnsafe(bound + 1);
    let offset = 0;
    while (offset <= bound) {
      const { bytesRead } = await handle.read(bytes, offset, bound + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || offset !== before.size) {
      fail(500, options.tooLargeCode ?? 'FOLDY_STORAGE_SIZE_INVALID', 'daemon-owned Foldy file changed while being read');
    }
    if (fence.length > 0) await assertStorageFence(fence);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isLogicalPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value !== '.' && !value.startsWith('../');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableId(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isNullableIsoDate(value: unknown): value is string | null {
  return value === null || isIsoDate(value);
}

function validRevisionSummary(value: unknown): value is FoldyRevisionSummary {
  if (!isRecord(value)) return false;
  return isId(value.revisionId) && isLogicalPath(value.entryFile) && isIsoDate(value.createdAt)
    && isId(value.createdBy) && isNonNegativeInteger(value.fileCount) && isNonNegativeInteger(value.byteCount)
    && typeof value.bundleSha256 === 'string' && DIGEST_PATTERN.test(value.bundleSha256);
}

function validComment(value: unknown, reviewId: string, revisionId: string): value is FoldyReviewComment {
  if (!isRecord(value)) return false;
  return isId(value.commentId) && value.reviewId === reviewId && value.revisionId === revisionId
    && typeof value.body === 'string' && value.body.trim().length > 0 && value.body.length <= 20_000
    && isIsoDate(value.createdAt) && isId(value.createdBy);
}

function validReview(value: unknown): value is FoldyReviewRecord {
  if (!isRecord(value) || !isId(value.reviewId) || !isId(value.revisionId)
    || !['requested', 'approved', 'changes_requested', 'stale'].includes(String(value.status))
    || !isNonNegativeInteger(value.version) || value.version < 1 || !isIsoDate(value.requestedAt)
    || !isId(value.requestedBy) || !Array.isArray(value.comments)
    || !value.comments.every((comment) => validComment(comment, value.reviewId as string, value.revisionId as string))
    || !isNullableIsoDate(value.decidedAt) || !isNullableId(value.decidedBy)
    || !isNullableIsoDate(value.staleAt) || !isNullableId(value.staleBecauseRevisionId)) return false;
  if ((value.status === 'approved' || value.status === 'changes_requested') && (value.decidedAt === null || value.decidedBy === null)) return false;
  if (value.status === 'stale' && (value.staleAt === null || value.staleBecauseRevisionId === null)) return false;
  return true;
}

function validTransition(value: unknown): value is FoldyPublicationTransition {
  if (!isRecord(value)) return false;
  return isId(value.transitionId) && (value.kind === 'publish' || value.kind === 'rollback')
    && isId(value.revisionId) && isNullableId(value.previousRevisionId) && isNonNegativeInteger(value.generation)
    && value.generation > 0 && isIsoDate(value.publishedAt) && isId(value.publishedBy);
}

function assertState(value: unknown, projectId: string): asserts value is MutableState {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.projectId !== projectId
    || !isNullableId(value.latestRevisionId) || !isNullableId(value.publishedRevisionId)
    || !isNonNegativeInteger(value.publishedGeneration) || !Array.isArray(value.revisions)
    || !value.revisions.every(validRevisionSummary) || !Array.isArray(value.reviews)
    || !value.reviews.every(validReview) || !Array.isArray(value.transitions)
    || !value.transitions.every(validTransition) || (value.activeReview !== null && !validReview(value.activeReview))) {
    fail(500, 'FOLDY_STATE_INVALID', 'Foldy publication state has an unsupported or corrupt shape');
  }
  const revisionIds = new Set(value.revisions.map((revision) => revision.revisionId));
  const reviewIds = new Set(value.reviews.map((review) => review.reviewId));
  const transitionIds = new Set(value.transitions.map((transition) => transition.transitionId));
  const unique = revisionIds.size === value.revisions.length && reviewIds.size === value.reviews.length
    && transitionIds.size === value.transitions.length;
  const referencesValid = (value.latestRevisionId === null || revisionIds.has(value.latestRevisionId))
    && (value.publishedRevisionId === null || revisionIds.has(value.publishedRevisionId))
    && value.reviews.every((review) => revisionIds.has(review.revisionId)
      && (review.staleBecauseRevisionId === null || revisionIds.has(review.staleBecauseRevisionId)))
    && value.transitions.every((transition) => revisionIds.has(transition.revisionId));
  let previous: string | null = null;
  const chainValid = value.transitions.every((transition, index) => {
    const valid = transition.generation === index + 1 && transition.previousRevisionId === previous;
    previous = transition.revisionId;
    return valid;
  });
  const publicationValid = value.publishedGeneration === value.transitions.length
    && value.publishedRevisionId === (value.transitions.at(-1)?.revisionId ?? null);
  const activeReview = value.activeReview as FoldyReviewRecord | null;
  const activeValid = activeReview === null
    || (activeReview.status === 'requested'
      && activeReview.revisionId === value.latestRevisionId
      && value.reviews.some((review) => review.reviewId === activeReview.reviewId
        && JSON.stringify(review) === JSON.stringify(activeReview)));
  if (!unique || !referencesValid || !chainValid || !publicationValid || !activeValid) {
    fail(500, 'FOLDY_STATE_INVALID', 'Foldy publication state failed integrity validation');
  }
}

async function snapshotFiles(
  projectRoot: string,
  requestedFiles: readonly string[],
  limits: ResolvedSnapshotLimits,
  testHooks?: FoldyPublicationStoreTestHooks,
): Promise<Array<FoldyRevisionFile & { bytes: Buffer }>> {
  const included = new Set<string>();
  for (const candidate of requestedFiles) {
    if (typeof candidate !== 'string' || !isLogicalPath(candidate)) {
      fail(422, 'FOLDY_PUBLICATION_FILE_INVALID', 'publication file declarations must be normalized relative file paths');
    }
    const segments = candidate.split('/');
    const basename = segments.at(-1)!.toLowerCase();
    if (segments.some((segment) => segment.startsWith('.') || EXCLUDED_PATH_SEGMENTS.has(segment.toLowerCase()))
      || EXCLUDED_FILE_NAMES.has(basename)
      || /(?:credential|secret|private[-_.]?key)/i.test(basename)
      || /\.(?:ts|tsx|map)$/i.test(basename)) {
      fail(422, 'FOLDY_PUBLICATION_FILE_UNSAFE', 'publication file declaration targets private or build-only content');
    }
    included.add(candidate);
  }
  if (included.size === 0) fail(422, 'FOLDY_PUBLICATION_FILE_INVALID', 'publication must include at least the enrolled entry');
  const rootStat = await lstat(projectRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail(422, 'FOLDY_PROJECT_ROOT_INVALID', 'project root must be a regular directory');

  let rootHandle: FileHandle;
  try {
    rootHandle = await open(projectRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    fail(422, 'FOLDY_PROJECT_ROOT_INVALID', 'project root changed while being opened');
  }
  const openedRoot = await rootHandle.stat();
  if (!openedRoot.isDirectory() || openedRoot.dev !== rootStat.dev || openedRoot.ino !== rootStat.ino) {
    await rootHandle.close();
    fail(422, 'FOLDY_PROJECT_ROOT_INVALID', 'project root changed while being opened');
  }

  const directoryFence: DescriptorFenceEntry[] = [{
    path: projectRoot,
    dev: openedRoot.dev,
    ino: openedRoot.ino,
    handle: rootHandle,
  }];
  const files: Array<FoldyRevisionFile & { bytes: Buffer }> = [];
  let totalBytes = 0;

  const assertProjectFence = async (): Promise<void> => {
    for (const entry of directoryFence) {
      const [pathStat, descriptorStat] = await Promise.all([
        lstat(entry.path).catch(() => null),
        entry.handle.stat().catch(() => null),
      ]);
      if (!pathStat || !descriptorStat || pathStat.isSymbolicLink() || !pathStat.isDirectory()
        || pathStat.dev !== entry.dev || pathStat.ino !== entry.ino
        || descriptorStat.dev !== entry.dev || descriptorStat.ino !== entry.ino) {
        fail(422, 'FOLDY_UNSAFE_PROJECT_FILE', 'project path changed identity during snapshot');
      }
    }
  };

  const readSnapshotFile = async (handle: FileHandle, expected: FileIdentity, expectedSize: number): Promise<Buffer> => {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
      fail(422, 'FOLDY_UNSAFE_PROJECT_FILE', 'project file changed identity while being opened');
    }
    const bytes = Buffer.allocUnsafe(expectedSize + 1);
    let offset = 0;
    while (offset <= expectedSize) {
      const { bytesRead } = await handle.read(bytes, offset, expectedSize + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || offset !== before.size) {
      fail(422, 'FOLDY_UNSAFE_PROJECT_FILE', 'project file changed while being read');
    }
    return bytes.subarray(0, offset);
  };

  const walk = async (directory: DescriptorFenceEntry, prefix: string, depth: number): Promise<void> => {
    if (depth >= limits.maxDepth) fail(422, 'FOLDY_SNAPSHOT_DEPTH_LIMIT', 'project snapshot exceeds the maximum directory depth');
    await assertProjectFence();
    const entries = await readdir(descriptorPath(directory), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const originalPath = path.join(directory.path, entry.name);
      const anchoredPath = descriptorPath(directory, entry.name);
      const stat = await lstat(anchoredPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (![...included].some((candidate) => candidate.startsWith(`${relative}/`))) continue;
        const childHandle = await open(anchoredPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const childStat = await childHandle.stat();
        if (!childStat.isDirectory() || childStat.dev !== stat.dev || childStat.ino !== stat.ino) {
          await childHandle.close();
          fail(422, 'FOLDY_UNSAFE_PROJECT_FILE', 'project directory changed identity while being opened');
        }
        const child = { path: originalPath, dev: childStat.dev, ino: childStat.ino, handle: childHandle };
        directoryFence.push(child);
        try {
          await walk(child, relative, depth + 1);
        } finally {
          directoryFence.pop();
          await childHandle.close();
        }
      } else if (stat.isFile()) {
        if (!included.has(relative)) continue;
        if (files.length >= limits.maxFiles) fail(422, 'FOLDY_SNAPSHOT_FILE_LIMIT', 'project snapshot exceeds the maximum file count');
        if (stat.size > limits.maxFileBytes) fail(422, 'FOLDY_SNAPSHOT_FILE_SIZE_LIMIT', 'project snapshot contains a file larger than the configured maximum');
        if (!Number.isSafeInteger(stat.size) || totalBytes + stat.size > limits.maxTotalBytes) {
          fail(422, 'FOLDY_SNAPSHOT_TOTAL_SIZE_LIMIT', 'project snapshot exceeds the maximum total byte count');
        }
        await testHooks?.beforeSnapshotFileOpen?.(projectRoot, relative);
        await assertProjectFence();
        let fileHandle: FileHandle;
        try {
          fileHandle = await open(anchoredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch {
          fail(422, 'FOLDY_UNSAFE_PROJECT_FILE', 'project file changed while being opened');
        }
        let bytes: Buffer;
        try {
          bytes = await readSnapshotFile(fileHandle, { path: originalPath, dev: stat.dev, ino: stat.ino }, stat.size);
        } finally {
          await fileHandle.close();
        }
        const pathStat = await lstat(anchoredPath).catch(() => null);
        if (!pathStat || !pathStat.isFile() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
          fail(422, 'FOLDY_UNSAFE_PROJECT_FILE', 'project file changed identity during snapshot');
        }
        await assertProjectFence();
        if (bytes.byteLength > limits.maxFileBytes) fail(422, 'FOLDY_SNAPSHOT_FILE_SIZE_LIMIT', 'project snapshot contains a file larger than the configured maximum');
        if (totalBytes + bytes.byteLength > limits.maxTotalBytes) fail(422, 'FOLDY_SNAPSHOT_TOTAL_SIZE_LIMIT', 'project snapshot exceeds the maximum total byte count');
        totalBytes += bytes.byteLength;
        files.push({ path: logicalPath(relative), sha256: sha256(bytes), size: bytes.byteLength, bytes });
      }
    }
  };

  try {
    await walk(directoryFence[0]!, '', 0);
    await assertProjectFence();
    if (files.length !== included.size) {
      fail(422, 'FOLDY_PUBLICATION_FILE_NOT_FOUND', 'a declared publication file is missing or is not a regular file');
    }
    return files;
  } finally {
    await rootHandle.close();
  }
}

export class FoldyPublicationStore {
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly snapshotLimits: ResolvedSnapshotLimits;
  private readonly testHooks: FoldyPublicationStoreTestHooks | undefined;
  private readonly deeplyVerifiedStates = new Map<string, string>();

  constructor(options: {
    rootDir: string;
    now?: () => Date;
    randomId?: () => string;
    snapshotLimits?: FoldySnapshotLimits;
    /** @internal */ testHooks?: FoldyPublicationStoreTestHooks;
  }) {
    if (!path.isAbsolute(options.rootDir)) fail(400, 'FOLDY_INVALID_ROOT', 'Foldy runtime rootDir must be absolute');
    this.rootDir = path.resolve(options.rootDir);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID());
    this.testHooks = options.testHooks;
    this.snapshotLimits = {
      maxDepth: validatePositiveLimit(options.snapshotLimits?.maxDepth ?? DEFAULT_SNAPSHOT_LIMITS.maxDepth, 'maxDepth'),
      maxFiles: validatePositiveLimit(options.snapshotLimits?.maxFiles ?? DEFAULT_SNAPSHOT_LIMITS.maxFiles, 'maxFiles'),
      maxFileBytes: validatePositiveLimit(options.snapshotLimits?.maxFileBytes ?? DEFAULT_SNAPSHOT_LIMITS.maxFileBytes, 'maxFileBytes'),
      maxTotalBytes: validatePositiveLimit(options.snapshotLimits?.maxTotalBytes ?? DEFAULT_SNAPSHOT_LIMITS.maxTotalBytes, 'maxTotalBytes'),
    };
  }

  private projectDir(projectId: string): string {
    return path.join(this.rootDir, 'projects', validateId(projectId, 'project'));
  }

  private async prepareProject(projectId: string): Promise<string> {
    const projectDir = this.projectDir(projectId);
    await mkdirStorageDirectory(this.rootDir, projectDir, this.testHooks);
    return projectDir;
  }

  private async withProjectLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    // Keep publication transitions in the same in-process serialization domain
    // as v0.7 Foldy promotion/signing while retaining the durable inter-process
    // lock below. The shared lock is deliberately outermost so a publication
    // cannot race a legacy promotion for the same project.
    return withFoldyProjectLock(projectId, () => this.withDurableProjectLock(projectId, task));
  }

  private async withDurableProjectLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const projectDir = await this.prepareProject(projectId);
    const locksDir = path.join(projectDir, '.publication-locks');
    await mkdirStorageDirectory(this.rootDir, locksDir, this.testHooks);
    const token = randomUUID();
    const ownerName = `owner.${token}.json`;
    const startedAt = Date.now();
    let lockFence: DescriptorFenceEntry[] | undefined;

    for (;;) {
      const fence = await openDescriptorFence(this.rootDir, locksDir);
      const lockEntry = fence.at(-1)!;
      const lockHandle = lockEntry.handle;
      const ownerPath = descriptorPath(lockEntry, ownerName);
      const heldPath = descriptorPath(lockEntry, 'held');
      let ownerHandle: FileHandle | undefined;
      let linked = false;
      try {
        ownerHandle = await open(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        const owner = { pid: process.pid, token, acquiredAt: new Date().toISOString() };
        await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`);
        await ownerHandle.sync();
        try {
          await link(ownerPath, heldPath);
          linked = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await ownerHandle.close();
          ownerHandle = undefined;
          await rm(ownerPath, { force: true });
          await this.recoverStaleLock(fence, locksDir);
          await closeDescriptorFence(fence);
          if (Date.now() - startedAt >= LOCK_WAIT_MS) {
            fail(409, 'FOLDY_PROJECT_LOCK_TIMEOUT', 'timed out waiting for the Foldy project lock');
          }
          await delay(LOCK_POLL_MS);
          continue;
        }
        await this.testHooks?.beforeStorageMutation?.('lock-acquire', path.join(locksDir, 'held'));
        const [ownerStat, heldStat] = await Promise.all([ownerHandle.stat(), lstat(heldPath)]);
        if (!ownerStat.isFile() || !heldStat.isFile()
          || ownerStat.dev !== heldStat.dev || ownerStat.ino !== heldStat.ino) {
          fail(500, 'FOLDY_UNSAFE_STORAGE', 'Foldy project lock changed identity during acquisition');
        }
        await assertDescriptorFence(fence);
        await lockHandle.sync();
        await assertOptionalIdentity(heldPath, { path: heldPath, dev: ownerStat.dev, ino: ownerStat.ino });
        await assertOptionalIdentity(ownerPath, { path: ownerPath, dev: ownerStat.dev, ino: ownerStat.ino });
        await ownerHandle.close();
        ownerHandle = undefined;
        lockFence = fence;
        break;
      } catch (error) {
        await ownerHandle?.close();
        if (linked) await rm(heldPath, { force: true }).catch(() => undefined);
        await rm(ownerPath, { force: true }).catch(() => undefined);
        await closeDescriptorFence(fence);
        throw error;
      }
    }

    try {
      return await task();
    } finally {
      try {
        await this.releaseProjectLock(lockFence!, locksDir, token);
      } finally {
        await closeDescriptorFence(lockFence!);
      }
    }
  }

  private async recoverStaleLock(fence: DescriptorFenceEntry[], locksDir: string): Promise<void> {
    const lockEntry = fence.at(-1)!;
    const lockHandle = lockEntry.handle;
    const heldPath = descriptorPath(lockEntry, 'held');
    const lockStat = await lstat(heldPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!lockStat) return;
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) fail(500, 'FOLDY_UNSAFE_STORAGE', 'Foldy project lock is not a regular file');
    const ageMs = Date.now() - lockStat.mtimeMs;
    let owner: { pid: number; token: string } | null = null;
    try {
      const bytes = await readRegularNoFollow(heldPath, { maxBytes: 4096, tooLargeCode: 'FOLDY_PROJECT_LOCK_INVALID' });
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      if (isRecord(parsed) && Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
        && typeof parsed.token === 'string' && LOCK_TOKEN_PATTERN.test(parsed.token)) {
        owner = { pid: parsed.pid as number, token: parsed.token };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof FoldyPublicationStoreError) throw error;
    }
    let stale = ageMs >= MALFORMED_LOCK_STALE_MS;
    if (owner && ageMs >= DEAD_LOCK_GRACE_MS) {
      try {
        process.kill(owner.pid, 0);
        stale = false;
      } catch (error) {
        stale = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    if (!stale) return;

    const heldIdentity = { path: heldPath, dev: lockStat.dev, ino: lockStat.ino };
    const ownerPath = owner ? descriptorPath(lockEntry, `owner.${owner.token}.json`) : null;
    const ownerIdentity = ownerPath ? await captureOptionalIdentity(ownerPath) : null;
    await this.testHooks?.beforeStorageMutation?.('lock-recover', path.join(locksDir, 'held'));
    await assertDescriptorFence(fence);
    await assertOptionalIdentity(heldPath, heldIdentity);
    if (ownerIdentity && (ownerIdentity.dev !== heldIdentity.dev || ownerIdentity.ino !== heldIdentity.ino)) {
      fail(500, 'FOLDY_PROJECT_LOCK_INVALID', 'Foldy project lock owner link does not match the held lock');
    }
    await rm(heldPath);
    if (ownerPath && ownerIdentity) await rm(ownerPath);
    await lockHandle.sync();
    await assertDescriptorFence(fence);
  }

  private async releaseProjectLock(fence: DescriptorFenceEntry[], locksDir: string, token: string): Promise<void> {
    const lockEntry = fence.at(-1)!;
    const lockHandle = lockEntry.handle;
    const heldPath = descriptorPath(lockEntry, 'held');
    const ownerPath = descriptorPath(lockEntry, `owner.${token}.json`);
    const bytes = await readRegularNoFollow(heldPath, { maxBytes: 4096, tooLargeCode: 'FOLDY_PROJECT_LOCK_INVALID' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail(500, 'FOLDY_PROJECT_LOCK_INVALID', 'Foldy project lock owner metadata is invalid');
    }
    if (!isRecord(parsed) || parsed.pid !== process.pid || parsed.token !== token) {
      fail(500, 'FOLDY_PROJECT_LOCK_LOST', 'Foldy project lock ownership changed before release');
    }
    const [heldIdentity, ownerIdentity] = await Promise.all([
      captureOptionalIdentity(heldPath),
      captureOptionalIdentity(ownerPath),
    ]);
    if (!heldIdentity || !ownerIdentity
      || heldIdentity.dev !== ownerIdentity.dev || heldIdentity.ino !== ownerIdentity.ino) {
      fail(500, 'FOLDY_PROJECT_LOCK_LOST', 'Foldy project lock ownership changed before release');
    }
    await this.testHooks?.beforeStorageMutation?.('lock-release', path.join(locksDir, 'held'));
    await assertDescriptorFence(fence);
    await assertOptionalIdentity(heldPath, heldIdentity);
    await assertOptionalIdentity(ownerPath, ownerIdentity);
    await rm(heldPath);
    await rm(ownerPath);
    await lockHandle.sync();
    await assertDescriptorFence(fence);
  }

  private async readState(projectId: string): Promise<MutableState> {
    const projectDir = await this.prepareProject(projectId);
    const statePath = path.join(projectDir, 'state.json');
    await rejectSymlink(statePath);
    let bytes: Buffer;
    try {
      bytes = await readRegularNoFollow(statePath, { storageRoot: this.rootDir, maxBytes: MAX_STATE_BYTES, tooLargeCode: 'FOLDY_STATE_TOO_LARGE' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const state = emptyState(projectId);
        await this.reconcileReceipts(projectId, state);
        return state;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail(500, 'FOLDY_STATE_INVALID', 'Foldy publication state is not valid JSON');
    }
    assertState(parsed, projectId);
    const fingerprint = sha256(bytes);
    if (this.deeplyVerifiedStates.get(projectId) !== fingerprint) {
      await this.verifyRevisionStorage(projectId, parsed);
    }
    await this.reconcileReceipts(projectId, parsed);
    this.deeplyVerifiedStates.set(projectId, fingerprint);
    return parsed;
  }

  private async verifyRevisionStorage(projectId: string, state: MutableState): Promise<void> {
    const projectDir = await this.prepareProject(projectId);
    const verifiedBlobs = new Map<string, number>();
    for (const summary of state.revisions) {
      const revision = await this.requireRevision(projectId, summary.revisionId, state);
      for (const file of revision.files) {
        const verifiedSize = verifiedBlobs.get(file.sha256);
        if (verifiedSize !== undefined) {
          if (verifiedSize !== file.size) fail(500, 'FOLDY_BLOB_CORRUPT', 'immutable Foldy blob failed verification');
          continue;
        }
        const blobPath = path.join(projectDir, 'blobs', 'sha256', file.sha256.slice(0, 2), file.sha256);
        let bytes: Buffer;
        try {
          bytes = await readRegularNoFollow(blobPath, { storageRoot: this.rootDir, maxBytes: file.size, expectedSize: file.size, tooLargeCode: 'FOLDY_BLOB_CORRUPT' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            fail(500, 'FOLDY_BLOB_MISSING', 'saved revision references a missing immutable Foldy blob');
          }
          throw error;
        }
        if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
          fail(500, 'FOLDY_BLOB_CORRUPT', 'immutable Foldy blob failed verification');
        }
        verifiedBlobs.set(file.sha256, bytes.byteLength);
      }
    }
  }

  private async reconcileReceipts(projectId: string, state: MutableState): Promise<void> {
    const projectDir = await this.prepareProject(projectId);
    const transitionsDir = path.join(projectDir, 'transitions');
    let transitionsFence: DescriptorFenceEntry[] | null = null;
    try {
      transitionsFence = await openDescriptorFence(this.rootDir, transitionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entries = transitionsFence
      ? await readdir(descriptorPath(transitionsFence.at(-1)!), { withFileTypes: true })
      : [];
    if (transitionsFence) await assertDescriptorFence(transitionsFence);
    const expectedNames = new Set(state.transitions.map((transition) => `${transition.transitionId}.json`));
    // State is authoritative: only missing/corrupt expected regular receipts are repaired.
    // Any extra or non-regular artifact is ambiguous and therefore fails closed.
    try {
      for (const entry of entries) {
        const directoryEntry = transitionsFence!.at(-1)!;
        const directoryHandle = directoryEntry.handle;
        const anchoredPath = descriptorPath(directoryEntry, entry.name);
        const identity = await captureOptionalIdentity(anchoredPath);
        if (!identity) fail(500, 'FOLDY_UNSAFE_STORAGE', 'transition receipt artifact changed during reconciliation');
        if (RECEIPT_TEMP_PATTERN.test(entry.name)) {
          await this.testHooks?.beforeStorageMutation?.('receipt-temp-cleanup', path.join(transitionsDir, entry.name));
          await assertDescriptorFence(transitionsFence!);
          await assertOptionalIdentity(anchoredPath, identity);
          await rm(anchoredPath);
          await directoryHandle.sync();
          await assertDescriptorFence(transitionsFence!);
          continue;
        }
        if (!expectedNames.has(entry.name)) {
          fail(500, 'FOLDY_TRANSITION_RECEIPTS_INVALID', 'transition receipts contain an artifact not present in publication state');
        }
      }
      if (transitionsFence) await assertDescriptorFence(transitionsFence);
    } finally {
      if (transitionsFence) await closeDescriptorFence(transitionsFence);
    }
    for (const transition of state.transitions) {
      const receiptPath = path.join(transitionsDir, `${transition.transitionId}.json`);
      const expected = Buffer.from(`${JSON.stringify(transition, null, 2)}\n`);
      let current: Buffer | null = null;
      try {
        current = await readRegularNoFollow(receiptPath, { storageRoot: this.rootDir, maxBytes: expected.byteLength, tooLargeCode: 'FOLDY_TRANSITION_RECEIPTS_INVALID' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT'
          || (error instanceof FoldyPublicationStoreError && error.code === 'FOLDY_TRANSITION_RECEIPTS_INVALID')) {
          current = null;
        } else {
          throw error;
        }
      }
      if (!current?.equals(expected)) await atomicReplaceJson(this.rootDir, receiptPath, transition, this.testHooks);
    }
  }

  private async writeState(projectId: string, state: MutableState): Promise<void> {
    await atomicReplaceJson(this.rootDir, path.join(await this.prepareProject(projectId), 'state.json'), state, this.testHooks);
    this.deeplyVerifiedStates.set(projectId, sha256(`${JSON.stringify(state, null, 2)}\n`));
  }

  private nextId(kind: 'revision' | 'review' | 'comment' | 'transition'): string {
    return validateId(this.randomId(), kind);
  }

  async getState(projectId: string): Promise<FoldyPublicationProjectState> {
    validateId(projectId, 'project');
    return this.withProjectLock(projectId, async () => clone(await this.readState(projectId)));
  }

  async getRevision(projectId: string, revisionId: string): Promise<FoldyRevisionRecord> {
    validateId(projectId, 'project');
    validateId(revisionId, 'revision');
    return this.withProjectLock(projectId, async () => clone(await this.requireRevision(projectId, revisionId)));
  }

  async saveRevision(input: SaveFoldyRevisionInput): Promise<FoldyRevisionRecord> {
    validateId(input.projectId, 'project');
    validateId(input.actorId, 'actor');
    logicalPath(input.entryFile);
    if (input.expectedLatestRevisionId !== null) validateId(input.expectedLatestRevisionId, 'revision');
    return this.withProjectLock(input.projectId, async () => {
      const state = await this.readState(input.projectId);
      if (state.latestRevisionId !== input.expectedLatestRevisionId) {
        fail(409, 'FOLDY_LATEST_REVISION_CONFLICT', 'latest saved revision changed', {
          expectedLatestRevisionId: input.expectedLatestRevisionId,
          actualLatestRevisionId: state.latestRevisionId,
        });
      }
      const captured = await snapshotFiles(
        input.projectRoot,
        input.publicationFiles ?? [input.entryFile],
        this.snapshotLimits,
        this.testHooks,
      );
      if (!captured.some((file) => file.path === input.entryFile)) fail(422, 'FOLDY_ENTRY_FILE_NOT_FOUND', 'entry file is not a regular snapshotted file');
      const projectDir = await this.prepareProject(input.projectId);
      for (const file of captured) {
        const blob = path.join(projectDir, 'blobs', 'sha256', file.sha256.slice(0, 2), file.sha256);
        const created = await createImmutableFile(this.rootDir, blob, file.bytes, this.testHooks);
        if (!created) {
          const existing = await readRegularNoFollow(blob, { storageRoot: this.rootDir, maxBytes: file.bytes.byteLength, expectedSize: file.bytes.byteLength, tooLargeCode: 'FOLDY_BLOB_CORRUPT' });
          if (sha256(existing) !== file.sha256) fail(500, 'FOLDY_BLOB_CORRUPT', 'existing content-addressed blob failed verification');
        }
      }
      const revisionId = this.nextId('revision');
      if (state.revisions.some((revision) => revision.revisionId === revisionId)) fail(409, 'FOLDY_ID_COLLISION', 'revision id already exists');
      const files = captured.map(({ bytes: _bytes, ...file }) => file);
      const canonicalBundle = files.map((file) => `${file.path}\0${file.sha256}\0${file.size}\n`).join('');
      const record: FoldyRevisionRecord = {
        revisionId,
        entryFile: input.entryFile,
        createdAt: iso(this.now),
        createdBy: input.actorId,
        fileCount: files.length,
        byteCount: files.reduce((total, file) => total + file.size, 0),
        bundleSha256: sha256(canonicalBundle),
        files,
      };
      const manifestPath = path.join(projectDir, 'revisions', revisionId, 'manifest.json');
      const manifestCreated = await createImmutableFile(this.rootDir, manifestPath, Buffer.from(`${JSON.stringify(record, null, 2)}\n`), this.testHooks);
      if (!manifestCreated) fail(409, 'FOLDY_ID_COLLISION', 'revision manifest already exists');

      const staleAt = iso(this.now);
      state.reviews = state.reviews.map((review) => {
        if (review.revisionId === revisionId || (review.status !== 'approved' && review.status !== 'requested')) return review;
        return { ...review, status: 'stale', version: review.version + 1, staleAt, staleBecauseRevisionId: revisionId };
      });
      state.latestRevisionId = revisionId;
      state.revisions.push(record);
      state.activeReview = null;
      await this.writeState(input.projectId, state);
      return clone(record);
    });
  }

  async requestReview(input: RequestFoldyReviewInput): Promise<FoldyReviewRecord> {
    validateId(input.projectId, 'project');
    validateId(input.revisionId, 'revision');
    validateId(input.expectedLatestRevisionId, 'revision');
    validateId(input.actorId, 'actor');
    return this.withProjectLock(input.projectId, async () => {
      const state = await this.readState(input.projectId);
      if (state.latestRevisionId !== input.expectedLatestRevisionId || input.revisionId !== state.latestRevisionId) {
        fail(409, 'FOLDY_LATEST_REVISION_CONFLICT', 'review must target the expected latest saved revision');
      }
      await this.requireRevision(input.projectId, input.revisionId, state);
      const reviewId = this.nextId('review');
      if (state.reviews.some((item) => item.reviewId === reviewId)) fail(409, 'FOLDY_ID_COLLISION', 'review id already exists');
      const review: FoldyReviewRecord = {
        reviewId,
        revisionId: input.revisionId,
        status: 'requested',
        version: 1,
        requestedAt: iso(this.now),
        requestedBy: input.actorId,
        comments: [],
        decidedAt: null,
        decidedBy: null,
        staleAt: null,
        staleBecauseRevisionId: null,
      };
      state.reviews.push(review);
      state.activeReview = review;
      await this.writeState(input.projectId, state);
      return clone(review);
    });
  }

  async addReviewComment(input: AddFoldyReviewCommentInput): Promise<FoldyReviewComment> {
    validateGeneration(input.expectedReviewVersion, 'expectedReviewVersion');
    if (typeof input.body !== 'string' || input.body.trim().length === 0 || input.body.length > 20_000) {
      fail(422, 'FOLDY_REVIEW_COMMENT_INVALID', 'review comment must contain 1 to 20,000 characters');
    }
    return this.mutateReview(input, (review) => {
      if (review.status !== 'requested') fail(409, 'FOLDY_REVIEW_NOT_ACTIVE', 'comments require an active exact-revision review');
      const commentId = this.nextId('comment');
      if (review.comments.some((item) => item.commentId === commentId)) fail(409, 'FOLDY_ID_COLLISION', 'review comment id already exists');
      const comment: FoldyReviewComment = {
        commentId,
        reviewId: review.reviewId,
        revisionId: review.revisionId,
        body: input.body,
        createdAt: iso(this.now),
        createdBy: input.actorId,
      };
      const updated: FoldyReviewRecord = { ...review, version: review.version + 1, comments: [...review.comments, comment] };
      return { updated, result: comment };
    });
  }

  async decideReview(input: DecideFoldyReviewInput): Promise<FoldyReviewRecord> {
    validateGeneration(input.expectedReviewVersion, 'expectedReviewVersion');
    if (input.decision !== 'approved' && input.decision !== 'changes_requested') fail(422, 'FOLDY_REVIEW_DECISION_INVALID', 'invalid review decision');
    return this.mutateReview(input, (review) => {
      if (review.status !== 'requested') fail(409, 'FOLDY_REVIEW_NOT_ACTIVE', 'review is no longer active');
      const updated: FoldyReviewRecord = {
        ...review,
        status: input.decision,
        version: review.version + 1,
        decidedAt: iso(this.now),
        decidedBy: input.actorId,
      };
      return { updated, result: updated };
    });
  }

  private async mutateReview<T>(
    input: { projectId: string; revisionId: string; reviewId: string; expectedReviewVersion: number; actorId: string },
    mutate: (review: FoldyReviewRecord) => { updated: FoldyReviewRecord; result: T },
  ): Promise<T> {
    validateId(input.projectId, 'project');
    validateId(input.revisionId, 'revision');
    validateId(input.reviewId, 'review');
    validateId(input.actorId, 'actor');
    return this.withProjectLock(input.projectId, async () => {
      const state = await this.readState(input.projectId);
      const index = state.reviews.findIndex((review) => review.reviewId === input.reviewId && review.revisionId === input.revisionId);
      if (index < 0) fail(404, 'FOLDY_REVIEW_NOT_FOUND', 'review was not found for the exact revision');
      const current = state.reviews[index]!;
      if (current.version !== input.expectedReviewVersion) {
        fail(409, 'FOLDY_REVIEW_VERSION_CONFLICT', 'review version changed', {
          expectedReviewVersion: input.expectedReviewVersion,
          actualReviewVersion: current.version,
        });
      }
      const { updated, result } = mutate(current);
      state.reviews[index] = updated;
      state.activeReview = updated.status === 'requested' ? updated : null;
      await this.writeState(input.projectId, state);
      return clone(result);
    });
  }

  async publish(input: PublishFoldyRevisionInput): Promise<FoldyPublishedRevision> {
    validateId(input.projectId, 'project');
    validateId(input.revisionId, 'revision');
    validateId(input.actorId, 'actor');
    validateGeneration(input.expectedPublishedGeneration, 'expectedPublishedGeneration');
    return this.withProjectLock(input.projectId, async () => {
      const state = await this.readState(input.projectId);
      this.assertPublicationCas(state, input.expectedPublishedGeneration);
      await this.requireRevision(input.projectId, input.revisionId, state);
      const approved = state.reviews.some((review) => review.revisionId === input.revisionId && review.status === 'approved');
      if (!approved) fail(409, 'FOLDY_APPROVAL_REQUIRED', 'publication requires a current exact-revision approval');
      return this.commitPublication(input.projectId, state, input.revisionId, input.actorId, 'publish');
    });
  }

  async rollback(input: RollbackFoldyPublicationInput): Promise<FoldyPublishedRevision> {
    validateId(input.projectId, 'project');
    validateId(input.targetRevisionId, 'revision');
    validateId(input.actorId, 'actor');
    validateGeneration(input.expectedPublishedGeneration, 'expectedPublishedGeneration');
    return this.withProjectLock(input.projectId, async () => {
      const state = await this.readState(input.projectId);
      this.assertPublicationCas(state, input.expectedPublishedGeneration);
      await this.requireRevision(input.projectId, input.targetRevisionId, state);
      if (!state.transitions.some((transition) => transition.revisionId === input.targetRevisionId)) {
        fail(422, 'FOLDY_ROLLBACK_TARGET_NOT_PUBLISHED', 'rollback target must be a previously published revision');
      }
      return this.commitPublication(input.projectId, state, input.targetRevisionId, input.actorId, 'rollback');
    });
  }

  private assertPublicationCas(state: MutableState, expected: number): void {
    if (state.publishedGeneration !== expected) {
      fail(409, 'FOLDY_PUBLISHED_GENERATION_CONFLICT', 'published generation changed', {
        expectedPublishedGeneration: expected,
        actualPublishedGeneration: state.publishedGeneration,
      });
    }
  }

  private async commitPublication(
    projectId: string,
    state: MutableState,
    revisionId: string,
    actorId: string,
    kind: 'publish' | 'rollback',
  ): Promise<FoldyPublishedRevision> {
    const transition: FoldyPublicationTransition = {
      transitionId: this.nextId('transition'),
      kind,
      revisionId,
      previousRevisionId: state.publishedRevisionId,
      generation: state.publishedGeneration + 1,
      publishedAt: iso(this.now),
      publishedBy: actorId,
    };
    if (state.transitions.some((item) => item.transitionId === transition.transitionId)) fail(409, 'FOLDY_ID_COLLISION', 'publication transition id already exists');
    state.publishedRevisionId = revisionId;
    state.publishedGeneration = transition.generation;
    state.transitions.push(transition);
    await this.writeState(projectId, state);
    await this.reconcileReceipts(projectId, state);
    return clone(transition);
  }

  private async requireRevision(projectId: string, revisionId: string, state?: MutableState): Promise<FoldyRevisionRecord> {
    const current = state ?? await this.readState(projectId);
    if (!current.revisions.some((revision) => revision.revisionId === revisionId)) {
      fail(404, 'FOLDY_REVISION_NOT_FOUND', 'saved revision was not found');
    }
    const manifestPath = path.join(await this.prepareProject(projectId), 'revisions', revisionId, 'manifest.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readRegularNoFollow(manifestPath, { storageRoot: this.rootDir, maxBytes: MAX_MANIFEST_BYTES, tooLargeCode: 'FOLDY_REVISION_MANIFEST_INVALID' })).toString('utf8'));
    } catch (error) {
      if (error instanceof FoldyPublicationStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(500, 'FOLDY_REVISION_MANIFEST_MISSING', 'saved revision manifest is missing');
      fail(500, 'FOLDY_REVISION_MANIFEST_INVALID', 'saved revision manifest is invalid');
    }
    if (!validRevisionSummary(parsed) || parsed.revisionId !== revisionId) {
      fail(500, 'FOLDY_REVISION_MANIFEST_INVALID', 'saved revision manifest has an invalid shape');
    }
    const candidate = parsed as unknown as Record<string, unknown>;
    if (!Array.isArray(candidate.files)
      || !(candidate.files as unknown[]).every((file): file is FoldyRevisionFile => isRecord(file) && isLogicalPath((file as Record<string, unknown>).path)
        && typeof (file as Record<string, unknown>).sha256 === 'string' && DIGEST_PATTERN.test((file as Record<string, unknown>).sha256 as string)
        && isNonNegativeInteger((file as Record<string, unknown>).size))) {
      fail(500, 'FOLDY_REVISION_MANIFEST_INVALID', 'saved revision manifest has an invalid shape');
    }
    const record = parsed as unknown as FoldyRevisionRecord;
    const paths = new Set(record.files.map((file) => file.path));
    const byteCount = record.files.reduce((total, file) => total + file.size, 0);
    const canonicalBundle = record.files.map((file) => `${file.path}\0${file.sha256}\0${file.size}\n`).join('');
    if (paths.size !== record.files.length || !paths.has(record.entryFile) || record.fileCount !== record.files.length
      || !Number.isSafeInteger(byteCount) || record.byteCount !== byteCount || record.bundleSha256 !== sha256(canonicalBundle)) {
      fail(500, 'FOLDY_REVISION_MANIFEST_INVALID', 'saved revision manifest failed integrity validation');
    }
    const summary = current.revisions.find((revision) => revision.revisionId === revisionId)!;
    for (const key of ['entryFile', 'createdAt', 'createdBy', 'fileCount', 'byteCount', 'bundleSha256'] as const) {
      if (record[key] !== summary[key]) fail(500, 'FOLDY_REVISION_MANIFEST_INVALID', 'saved revision manifest does not match publication state');
    }
    return record;
  }

  private async resolveRevisionFileUnlocked(
    projectId: string,
    revisionId: string,
    safePath: string,
    state?: MutableState,
  ): Promise<FoldyResolvedFile> {
    const manifest = await this.requireRevision(projectId, revisionId, state);
    const file = manifest.files.find((item) => item.path === safePath);
    if (!file || !DIGEST_PATTERN.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) {
      fail(404, 'FOLDY_FILE_NOT_FOUND', 'file is not present in the saved revision');
    }
    const blobPath = path.join(await this.prepareProject(projectId), 'blobs', 'sha256', file.sha256.slice(0, 2), file.sha256);
    const bytes = await readRegularNoFollow(blobPath, { storageRoot: this.rootDir, maxBytes: file.size, expectedSize: file.size, tooLargeCode: 'FOLDY_BLOB_CORRUPT' });
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) fail(500, 'FOLDY_BLOB_CORRUPT', 'immutable Foldy blob failed verification');
    return { projectId, revisionId, path: safePath, sha256: file.sha256, size: file.size, bytes };
  }

  async resolveRevisionFile(projectId: string, revisionId: string, requestedPath: string): Promise<FoldyResolvedFile> {
    validateId(projectId, 'project');
    validateId(revisionId, 'revision');
    const safePath = logicalPath(requestedPath);
    return this.withProjectLock(projectId, async () => this.resolveRevisionFileUnlocked(projectId, revisionId, safePath));
  }

  async resolvePublishedFile(projectId: string, requestedPath: string): Promise<FoldyResolvedFile> {
    validateId(projectId, 'project');
    const safePath = logicalPath(requestedPath);
    return this.withProjectLock(projectId, async () => {
      const state = await this.readState(projectId);
      if (state.publishedRevisionId === null) fail(404, 'FOLDY_NOT_PUBLISHED', 'project has no published revision');
      return this.resolveRevisionFileUnlocked(projectId, state.publishedRevisionId, safePath, state);
    });
  }
}
