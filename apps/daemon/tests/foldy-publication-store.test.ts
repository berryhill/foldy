import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';

import {
  FoldyPublicationStore,
  FoldyPublicationStoreError,
  foldyStorageAccessKind,
  foldyStorageAccessPath,
} from '../src/foldy-publications/store.js';

const cleanupDirs = new Set<string>();
afterEach(async () => {
  await Promise.all([...cleanupDirs].map((directory) => rm(directory, { recursive: true, force: true })));
  cleanupDirs.clear();
});

async function fixture() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'foldy-publications-'));
  cleanupDirs.add(tempDir);
  const rootDir = path.join(tempDir, 'foldy-runtime');
  const projectRoot = path.join(tempDir, 'working-project');
  await mkdir(path.join(projectRoot, 'assets'), { recursive: true });
  await writeFile(path.join(projectRoot, 'index.html'), '<h1>R1</h1>');
  await writeFile(path.join(projectRoot, 'assets', 'app.css'), 'body { color: red; }');
  await mkdir(path.join(projectRoot, '.od'), { recursive: true });
  await writeFile(path.join(projectRoot, '.od', 'daemon.json'), 'not publication content');
  await symlink(path.join(tempDir, 'outside.txt'), path.join(projectRoot, 'linked-secret'));

  let id = 0;
  let tick = 0;
  const store = new FoldyPublicationStore({
    rootDir,
    now: () => new Date(Date.UTC(2026, 8, 8, 12, 0, tick++)),
    randomId: () => `id_${++id}`,
  });
  return { tempDir, rootDir, projectRoot, store };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FoldyPublicationStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

test('dispatches Linux to descriptor-relative access and Darwin to identity-fenced paths', () => {
  const anchor = { path: path.join(path.sep, 'var', 'foldy', 'projects'), fd: 42 };

  assert.equal(foldyStorageAccessKind('linux'), 'linux-descriptor-relative');
  assert.equal(foldyStorageAccessPath('linux', anchor), '/proc/self/fd/42');
  assert.equal(foldyStorageAccessPath('linux', anchor, 'state.json'), '/proc/self/fd/42/state.json');

  assert.equal(foldyStorageAccessKind('darwin'), 'darwin-identity-fenced');
  assert.equal(foldyStorageAccessPath('darwin', anchor), anchor.path);
  assert.equal(foldyStorageAccessPath('darwin', anchor, 'state.json'), path.join(anchor.path, 'state.json'));
});

test('fails closed when no hardened publication-store platform adapter exists', () => {
  assert.throws(
    () => foldyStorageAccessKind('win32'),
    (error: unknown) => error instanceof FoldyPublicationStoreError && error.code === 'FOLDY_UNSAFE_STORAGE',
  );
  assert.throws(
    () => foldyStorageAccessPath('freebsd', { path: '/storage', fd: 7 }, 'state.json'),
    (error: unknown) => error instanceof FoldyPublicationStoreError && error.code === 'FOLDY_UNSAFE_STORAGE',
  );
});

test('snapshots immutable regular files into content-addressed blobs and resolves safe paths', async () => {
  const f = await fixture();

  const revision = await f.store.saveRevision({
    projectId: 'project-one',
    projectRoot: f.projectRoot,
    entryFile: 'index.html',
    publicationFiles: ['index.html', 'assets/app.css'],
    expectedLatestRevisionId: null,
    actorId: 'author',
  });

  assert.equal(revision.revisionId, 'id_1');
  assert.deepEqual(revision.files.map((file) => file.path), ['assets/app.css', 'index.html']);
  assert.equal(revision.entryFile, 'index.html');
  assert.equal((await f.store.resolveRevisionFile('project-one', revision.revisionId, 'index.html')).bytes.toString(), '<h1>R1</h1>');

  await writeFile(path.join(f.projectRoot, 'index.html'), '<h1>mutable</h1>');
  assert.equal((await f.store.resolveRevisionFile('project-one', revision.revisionId, 'index.html')).bytes.toString(), '<h1>R1</h1>');

  const digest = revision.files.find((file) => file.path === 'index.html')!.sha256;
  assert.equal((await readFile(path.join(f.rootDir, 'projects', 'project-one', 'blobs', 'sha256', digest.slice(0, 2), digest))).toString(), '<h1>R1</h1>');
  await expectCode(f.store.resolveRevisionFile('project-one', revision.revisionId, '../state.json'), 'FOLDY_INVALID_PATH');
  await expectCode(f.store.resolveRevisionFile('../escape', revision.revisionId, 'index.html'), 'FOLDY_INVALID_PROJECT_ID');
});

test('persists review comments and makes an exact R1 approval stale after saving R2', async () => {
  const f = await fixture();

  const r1 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  let review = await f.store.requestReview({ projectId: 'p', revisionId: r1.revisionId, actorId: 'author', expectedLatestRevisionId: r1.revisionId });
  const comment = await f.store.addReviewComment({ projectId: 'p', revisionId: r1.revisionId, reviewId: review.reviewId, body: 'Looks exact.', actorId: 'reviewer', expectedReviewVersion: review.version });
  assert.equal(comment.body, 'Looks exact.');
  review = await f.store.decideReview({ projectId: 'p', revisionId: r1.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: 2 });
  assert.equal(review.status, 'approved');
  assert.equal(review.version, 3);

  await writeFile(path.join(f.projectRoot, 'index.html'), '<h1>R2</h1>');
  const r2 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: r1.revisionId, actorId: 'author' });
  assert.notEqual(r2.revisionId, r1.revisionId);

  const fresh = new FoldyPublicationStore({ rootDir: f.rootDir });
  const state = await fresh.getState('p');
  assert.equal(state.latestRevisionId, r2.revisionId);
  assert.equal(state.reviews[0]?.status, 'stale');
  assert.equal(state.reviews[0]?.staleBecauseRevisionId, r2.revisionId);
  assert.equal(state.activeReview, null);
  await expectCode(fresh.publish({ projectId: 'p', revisionId: r1.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' }), 'FOLDY_APPROVAL_REQUIRED');
});

test('publishes and rolls back with CAS while preserving prior published bytes on failure and restart', async () => {
  const f = await fixture();

  const r1 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  let review = await f.store.requestReview({ projectId: 'p', revisionId: r1.revisionId, actorId: 'author', expectedLatestRevisionId: r1.revisionId });
  await f.store.decideReview({ projectId: 'p', revisionId: r1.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: review.version });
  await f.store.publish({ projectId: 'p', revisionId: r1.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' });

  await writeFile(path.join(f.projectRoot, 'index.html'), '<h1>R2</h1>');
  const r2 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: r1.revisionId, actorId: 'author' });
  review = await f.store.requestReview({ projectId: 'p', revisionId: r2.revisionId, actorId: 'author', expectedLatestRevisionId: r2.revisionId });
  await f.store.decideReview({ projectId: 'p', revisionId: r2.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: review.version });
  const published = await f.store.publish({ projectId: 'p', revisionId: r2.revisionId, expectedPublishedGeneration: 1, actorId: 'publisher' });
  assert.equal(published.generation, 2);
  assert.equal((await f.store.resolvePublishedFile('p', 'index.html')).bytes.toString(), '<h1>R2</h1>');

  await expectCode(f.store.rollback({ projectId: 'p', targetRevisionId: r1.revisionId, expectedPublishedGeneration: 1, actorId: 'publisher' }), 'FOLDY_PUBLISHED_GENERATION_CONFLICT');
  assert.equal((await f.store.resolvePublishedFile('p', 'index.html')).bytes.toString(), '<h1>R2</h1>');

  const rolledBack = await f.store.rollback({ projectId: 'p', targetRevisionId: r1.revisionId, expectedPublishedGeneration: 2, actorId: 'publisher' });
  assert.equal(rolledBack.revisionId, r1.revisionId);
  assert.equal(rolledBack.generation, 3);

  const fresh = new FoldyPublicationStore({ rootDir: f.rootDir });
  assert.equal((await fresh.resolvePublishedFile('p', 'index.html')).bytes.toString(), '<h1>R1</h1>');
  const state = await fresh.getState('p');
  assert.deepEqual(state.transitions.map((item) => item.kind), ['publish', 'publish', 'rollback']);
});

test('resolves the published entry identity and bytes atomically against a concurrent rollback', async () => {
  const f = await fixture();
  const r1 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  let review = await f.store.requestReview({ projectId: 'p', revisionId: r1.revisionId, actorId: 'author', expectedLatestRevisionId: r1.revisionId });
  await f.store.decideReview({ projectId: 'p', revisionId: r1.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: review.version });
  await f.store.publish({ projectId: 'p', revisionId: r1.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' });

  await writeFile(path.join(f.projectRoot, 'alternate.xhtml'), '<html>R2</html>');
  const r2 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'alternate.xhtml', expectedLatestRevisionId: r1.revisionId, actorId: 'author' });
  review = await f.store.requestReview({ projectId: 'p', revisionId: r2.revisionId, actorId: 'author', expectedLatestRevisionId: r2.revisionId });
  await f.store.decideReview({ projectId: 'p', revisionId: r2.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: review.version });
  await f.store.publish({ projectId: 'p', revisionId: r2.revisionId, expectedPublishedGeneration: 1, actorId: 'publisher' });

  let releaseSelection!: () => void;
  const selectionReleased = new Promise<void>((resolve) => { releaseSelection = resolve; });
  let selected!: () => void;
  const entrySelected = new Promise<void>((resolve) => { selected = resolve; });
  const resolvingStore = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      afterPublishedEntrySelected: async () => {
        selected();
        await selectionReleased;
      },
    },
  });

  const resolving = resolvingStore.resolvePublishedEntry('p');
  await entrySelected;
  let rollbackFinished = false;
  const rollback = f.store.rollback({
    projectId: 'p', targetRevisionId: r1.revisionId, expectedPublishedGeneration: 2, actorId: 'publisher',
  }).then((transition) => {
    rollbackFinished = true;
    return transition;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rollbackFinished, false);

  releaseSelection();
  const resolved = await resolving;
  assert.equal(resolved.revisionId, r2.revisionId);
  assert.equal(resolved.path, 'alternate.xhtml');
  assert.equal(resolved.bytes.toString(), '<html>R2</html>');
  await rollback;
  assert.equal(rollbackFinished, true);
});

test('serializes per-project transitions and rejects stale revision CAS', async () => {
  const f = await fixture();

  const attempts = await Promise.allSettled([
    f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'a' }),
    f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'b' }),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = attempts.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  assert.ok(rejected?.reason instanceof FoldyPublicationStoreError);
  assert.equal(rejected.reason.code, 'FOLDY_LATEST_REVISION_CONFLICT');
});

test('rejects tampered symlinks in daemon-owned storage', async () => {
  const f = await fixture();
  const r1 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const manifestPath = path.join(f.rootDir, 'projects', 'p', 'revisions', r1.revisionId, 'manifest.json');
  await rm(manifestPath);
  await symlink(path.join(f.tempDir, 'outside.txt'), manifestPath);
  await expectCode(f.store.resolveRevisionFile('p', r1.revisionId, 'index.html'), 'FOLDY_UNSAFE_STORAGE');
});

test('rejects intermediate revisions and blobs symlinks while reading immutable files', async () => {
  const f = await fixture();
  const r1 = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const projectDir = path.join(f.rootDir, 'projects', 'p');
  const revisionsDir = path.join(projectDir, 'revisions');
  const outsideRevisions = path.join(f.tempDir, 'outside-read-revisions');
  await rename(revisionsDir, outsideRevisions);
  await symlink(outsideRevisions, revisionsDir);
  await expectCode(f.store.resolveRevisionFile('p', r1.revisionId, 'index.html'), 'FOLDY_UNSAFE_STORAGE');

  await rm(revisionsDir);
  await rename(outsideRevisions, revisionsDir);
  const blobsDir = path.join(projectDir, 'blobs');
  const outsideBlobs = path.join(f.tempDir, 'outside-read-blobs');
  await rename(blobsDir, outsideBlobs);
  await symlink(outsideBlobs, blobsDir);
  await expectCode(f.store.resolveRevisionFile('p', r1.revisionId, 'index.html'), 'FOLDY_UNSAFE_STORAGE');
});

test('rejects an intermediate blobs symlink instead of writing outside daemon-owned storage', async () => {
  const f = await fixture();
  const projectDir = path.join(f.rootDir, 'projects', 'p');
  const outsideBlobs = path.join(f.tempDir, 'outside-blobs');
  await mkdir(projectDir, { recursive: true });
  await mkdir(outsideBlobs);
  await symlink(outsideBlobs, path.join(projectDir, 'blobs'));

  await expectCode(
    f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' }),
    'FOLDY_UNSAFE_STORAGE',
  );
  assert.deepEqual(await readdir(outsideBlobs), []);
});

test('rejects an intermediate revisions symlink instead of writing a manifest outside daemon-owned storage', async () => {
  const f = await fixture();
  const projectDir = path.join(f.rootDir, 'projects', 'p');
  const outsideRevisions = path.join(f.tempDir, 'outside-revisions');
  await mkdir(projectDir, { recursive: true });
  await mkdir(outsideRevisions);
  await symlink(outsideRevisions, path.join(projectDir, 'revisions'));

  await expectCode(
    f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' }),
    'FOLDY_UNSAFE_STORAGE',
  );
  assert.deepEqual(await readdir(outsideRevisions), []);
});

test('immutable creation rejects ancestor replacement at commit without writing outside storage', async () => {
  const f = await fixture();
  const outside = path.join(f.tempDir, 'outside-immutable-race');
  await mkdir(outside);
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeStorageCommit: async (operation, target) => {
        if (raced || operation !== 'create' || !target.includes(`${path.sep}blobs${path.sep}`)) return;
        raced = true;
        const parent = path.dirname(target);
        await rename(parent, `${parent}.displaced`);
        await symlink(outside, parent);
      },
    },
  });

  await expectCode(
    store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' }),
    'FOLDY_UNSAFE_STORAGE',
  );
  assert.equal(raced, true);
  assert.deepEqual(await readdir(outside), []);
});

test('atomic replacement rejects ancestor replacement at commit without writing outside storage', async () => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const review = await f.store.requestReview({ projectId: 'p', revisionId: revision.revisionId, expectedLatestRevisionId: revision.revisionId, actorId: 'author' });
  const approved = await f.store.decideReview({ projectId: 'p', revisionId: revision.revisionId, reviewId: review.reviewId, decision: 'approved', expectedReviewVersion: review.version, actorId: 'reviewer' });
  assert.equal(approved.status, 'approved');
  const transition = await f.store.publish({ projectId: 'p', revisionId: revision.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' });
  const transitionsDir = path.join(f.rootDir, 'projects', 'p', 'transitions');
  await rm(path.join(transitionsDir, `${transition.transitionId}.json`));

  const outside = path.join(f.tempDir, 'outside-replace-race');
  await mkdir(outside);
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeStorageCommit: async (operation, target) => {
        if (raced || operation !== 'replace' || path.dirname(target) !== transitionsDir) return;
        raced = true;
        await rename(transitionsDir, `${transitionsDir}.displaced`);
        await symlink(outside, transitionsDir);
      },
    },
  });

  await expectCode(store.getState('p'), 'FOLDY_UNSAFE_STORAGE');
  assert.equal(raced, true);
  assert.deepEqual(await readdir(outside), []);
});

test('snapshot rejects project-root replacement between validation and file open without admission', async () => {
  const f = await fixture();
  const outside = path.join(f.tempDir, 'outside-snapshot-race');
  await mkdir(path.join(outside, 'assets'), { recursive: true });
  await writeFile(path.join(outside, 'assets', 'app.css'), 'outside secret');
  await writeFile(path.join(outside, 'index.html'), '<h1>outside secret</h1>');
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeSnapshotFileOpen: async (projectRoot) => {
        if (raced) return;
        raced = true;
        await rename(projectRoot, `${projectRoot}.displaced`);
        await symlink(outside, projectRoot);
      },
    },
  });

  await expectCode(
    store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' }),
    'FOLDY_UNSAFE_PROJECT_FILE',
  );
  assert.equal(raced, true);
  const state = await new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p');
  assert.equal(state.latestRevisionId, null);
  assert.deepEqual(state.revisions, []);
});

test('rejects an orphan revision manifest collision without advancing publication state', async () => {
  const f = await fixture();
  const manifestPath = path.join(f.rootDir, 'projects', 'p', 'revisions', 'id_1', 'manifest.json');
  const orphan = Buffer.from('{"revisionId":"orphan"}\n');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, orphan);

  await expectCode(
    f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' }),
    'FOLDY_ID_COLLISION',
  );
  assert.deepEqual(await readFile(manifestPath), orphan);
  const state = await f.store.getState('p');
  assert.equal(state.latestRevisionId, null);
  assert.deepEqual(state.revisions, []);
});

test('enforces bounded snapshot depth, file count, per-file bytes, and total bytes', async () => {
  const f = await fixture();
  const input = {
    projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html',
    publicationFiles: ['index.html', 'assets/app.css'],
    expectedLatestRevisionId: null, actorId: 'author',
  };

  await expectCode(new FoldyPublicationStore({ rootDir: path.join(f.tempDir, 'depth'), snapshotLimits: { maxDepth: 1 } }).saveRevision(input), 'FOLDY_SNAPSHOT_DEPTH_LIMIT');
  await expectCode(new FoldyPublicationStore({ rootDir: path.join(f.tempDir, 'files'), snapshotLimits: { maxFiles: 1 } }).saveRevision(input), 'FOLDY_SNAPSHOT_FILE_LIMIT');
  await expectCode(new FoldyPublicationStore({ rootDir: path.join(f.tempDir, 'file-size'), snapshotLimits: { maxFileBytes: 10 } }).saveRevision(input), 'FOLDY_SNAPSHOT_FILE_SIZE_LIMIT');
  await expectCode(new FoldyPublicationStore({ rootDir: path.join(f.tempDir, 'total-size'), snapshotLimits: { maxTotalBytes: 20 } }).saveRevision(input), 'FOLDY_SNAPSHOT_TOTAL_SIZE_LIMIT');
  assert.throws(
    () => new FoldyPublicationStore({ rootDir: path.join(f.tempDir, 'invalid'), snapshotLimits: { maxFiles: 0 } }),
    (error: unknown) => error instanceof FoldyPublicationStoreError && error.code === 'FOLDY_INVALID_SNAPSHOT_LIMIT',
  );
});

test('maps deeply malformed persisted state to a typed integrity error', async () => {
  const f = await fixture();
  await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const statePath = path.join(f.rootDir, 'projects', 'p', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { revisions: Array<{ bundleSha256: string }> };
  state.revisions[0]!.bundleSha256 = '../not-a-digest';
  await writeFile(statePath, JSON.stringify(state));
  await expectCode(f.store.getState('p'), 'FOLDY_STATE_INVALID');
});

test('rejects tampered manifest paths, counts, and tree digest', async () => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const manifestPath = path.join(f.rootDir, 'projects', 'p', 'revisions', revision.revisionId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: Array<{ path: string }>; fileCount: number };
  manifest.files[0]!.path = '../escape';
  manifest.fileCount = 999;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expectCode(f.store.resolveRevisionFile('p', revision.revisionId, 'index.html'), 'FOLDY_REVISION_MANIFEST_INVALID');
});

test('reconciles a corrupt expected transition receipt from authoritative state on restart', async () => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const review = await f.store.requestReview({ projectId: 'p', revisionId: revision.revisionId, actorId: 'author', expectedLatestRevisionId: revision.revisionId });
  await f.store.decideReview({ projectId: 'p', revisionId: revision.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: review.version });
  const transition = await f.store.publish({ projectId: 'p', revisionId: revision.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' });
  assert.equal(transition.transitionId, 'id_3');
  const receiptPath = path.join(f.rootDir, 'projects', 'p', 'transitions', 'id_3.json');
  await writeFile(receiptPath, '{"kind":"corrupt"}\n');

  const state = await new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p');
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), transition);
  assert.equal(state.publishedGeneration, 1);
  assert.deepEqual(state.transitions, [transition]);
});

test.each([
  ['missing', async (manifestPath: string) => rm(manifestPath), 'FOLDY_REVISION_MANIFEST_MISSING'],
  ['corrupt', async (manifestPath: string) => writeFile(manifestPath, '{not-json'), 'FOLDY_REVISION_MANIFEST_INVALID'],
] as const)('fresh-store getState rejects a %s manifest for every saved revision', async (_case, damage, code) => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  await writeFile(path.join(f.projectRoot, 'index.html'), '<h1>R2</h1>');
  await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: revision.revisionId, actorId: 'author' });
  const manifestPath = path.join(f.rootDir, 'projects', 'p', 'revisions', revision.revisionId, 'manifest.json');
  await damage(manifestPath);

  const fresh = new FoldyPublicationStore({ rootDir: f.rootDir });
  await expectCode(fresh.getState('p'), code);
});

test.each([
  ['missing', async (blobPath: string) => rm(blobPath), 'FOLDY_BLOB_MISSING'],
  ['corrupt with the same size', async (blobPath: string) => writeFile(blobPath, '<h1>X1</h1>'), 'FOLDY_BLOB_CORRUPT'],
  ['size-mismatched', async (blobPath: string) => writeFile(blobPath, 'short'), 'FOLDY_BLOB_CORRUPT'],
] as const)('fresh-store getState rejects a %s blob referenced by a manifest', async (_case, damage, code) => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const file = revision.files.find((item) => item.path === 'index.html')!;
  await writeFile(path.join(f.projectRoot, 'index.html'), '<h1>R2</h1>');
  await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: revision.revisionId, actorId: 'author' });
  const blobPath = path.join(f.rootDir, 'projects', 'p', 'blobs', 'sha256', file.sha256.slice(0, 2), file.sha256);
  await damage(blobPath);

  const fresh = new FoldyPublicationStore({ rootDir: f.rootDir });
  await expectCode(fresh.getState('p'), code);
});

test('receipt reconciliation fails closed on orphan or unexpectedly named transition artifacts', async () => {
  const f = await fixture();
  const transitionsDir = path.join(f.rootDir, 'projects', 'p', 'transitions');
  await mkdir(transitionsDir, { recursive: true });

  await writeFile(path.join(transitionsDir, 'orphan.json'), '{}\n');
  await expectCode(new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p'), 'FOLDY_TRANSITION_RECEIPTS_INVALID');
  await rm(path.join(transitionsDir, 'orphan.json'));
  await writeFile(path.join(transitionsDir, 'unexpected.tmp'), '{}\n');
  await expectCode(new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p'), 'FOLDY_TRANSITION_RECEIPTS_INVALID');
});

test('receipt reconciliation fails closed on a non-regular transition artifact', async () => {
  const f = await fixture();
  const artifactPath = path.join(f.rootDir, 'projects', 'p', 'transitions', 'orphan.json');
  await mkdir(artifactPath, { recursive: true });

  await expectCode(new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p'), 'FOLDY_UNSAFE_STORAGE');
});

test('fresh-store getState recreates a receipt missing after authoritative state commit', async () => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const review = await f.store.requestReview({ projectId: 'p', revisionId: revision.revisionId, actorId: 'author', expectedLatestRevisionId: revision.revisionId });
  await f.store.decideReview({ projectId: 'p', revisionId: revision.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: review.version });
  const transition = await f.store.publish({ projectId: 'p', revisionId: revision.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' });
  const receiptPath = path.join(f.rootDir, 'projects', 'p', 'transitions', `${transition.transitionId}.json`);
  await rm(receiptPath);

  const state = await new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p');
  assert.deepEqual(state.transitions, [transition]);
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), transition);
});

test('deep restart validation and receipt recovery never mutate the working copy', async () => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const review = await f.store.requestReview({ projectId: 'p', revisionId: revision.revisionId, actorId: 'author', expectedLatestRevisionId: revision.revisionId });
  await f.store.decideReview({ projectId: 'p', revisionId: revision.revisionId, reviewId: review.reviewId, decision: 'approved', actorId: 'reviewer', expectedReviewVersion: review.version });
  const transition = await f.store.publish({ projectId: 'p', revisionId: revision.revisionId, expectedPublishedGeneration: 0, actorId: 'publisher' });
  await rm(path.join(f.rootDir, 'projects', 'p', 'transitions', `${transition.transitionId}.json`));
  const before = await Promise.all([
    readFile(path.join(f.projectRoot, 'index.html')),
    readFile(path.join(f.projectRoot, 'assets', 'app.css')),
  ]);

  await new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p');

  const after = await Promise.all([
    readFile(path.join(f.projectRoot, 'index.html')),
    readFile(path.join(f.projectRoot, 'assets', 'app.css')),
  ]);
  assert.deepEqual(after, before);
});

test('recovers a bounded stale filesystem lock and safely removes it after mutation', async () => {
  const f = await fixture();
  await f.store.getState('p');
  const locksDir = path.join(f.rootDir, 'projects', 'p', '.publication-locks');
  const token = '123e4567-e89b-12d3-a456-426614174000';
  const ownerPath = path.join(locksDir, `owner.${token}.json`);
  await writeFile(ownerPath, JSON.stringify({ pid: 999_999_999, token, acquiredAt: '2020-01-01T00:00:00.000Z' }));
  await link(ownerPath, path.join(locksDir, 'held'));
  await utimes(path.join(locksDir, 'held'), new Date(0), new Date(0));

  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  assert.equal(revision.revisionId, 'id_1');
  await assert.rejects(readFile(path.join(locksDir, 'held')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  await assert.rejects(readFile(ownerPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('rejects persisted activeReview that is not the canonical requested review entry', async () => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  await f.store.requestReview({ projectId: 'p', revisionId: revision.revisionId, actorId: 'author', expectedLatestRevisionId: revision.revisionId });
  const statePath = path.join(f.rootDir, 'projects', 'p', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { activeReview: { version: number } };
  state.activeReview.version += 1;
  await writeFile(statePath, JSON.stringify(state));

  await expectCode(new FoldyPublicationStore({ rootDir: f.rootDir }).getState('p'), 'FOLDY_STATE_INVALID');
});

test('rejects generated review and comment id collisions with the typed collision error', async () => {
  const f = await fixture();
  const revision = await f.store.saveRevision({ projectId: 'p', projectRoot: f.projectRoot, entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'author' });
  const colliding = new FoldyPublicationStore({ rootDir: f.rootDir, randomId: () => 'same-id' });
  const review = await colliding.requestReview({ projectId: 'p', revisionId: revision.revisionId, actorId: 'author', expectedLatestRevisionId: revision.revisionId });
  await expectCode(colliding.requestReview({ projectId: 'p', revisionId: revision.revisionId, actorId: 'author', expectedLatestRevisionId: revision.revisionId }), 'FOLDY_ID_COLLISION');
  await colliding.addReviewComment({ projectId: 'p', revisionId: revision.revisionId, reviewId: review.reviewId, body: 'one', actorId: 'reviewer', expectedReviewVersion: 1 });
  await expectCode(colliding.addReviewComment({ projectId: 'p', revisionId: revision.revisionId, reviewId: review.reviewId, body: 'two', actorId: 'reviewer', expectedReviewVersion: 2 }), 'FOLDY_ID_COLLISION');
});

test('cleans a recognized abandoned receipt temp while reconciling under the project lock', async () => {
  const f = await fixture();
  const transitionsDir = path.join(f.rootDir, 'projects', 'p', 'transitions');
  const tempName = '.receipt.json.123.123e4567-e89b-12d3-a456-426614174000.tmp';
  await mkdir(transitionsDir, { recursive: true });
  await writeFile(path.join(transitionsDir, tempName), 'abandoned');

  await f.store.getState('p');
  assert.deepEqual(await readdir(transitionsDir), []);
});

test('rejects oversized state before parsing it', async () => {
  const f = await fixture();
  const statePath = path.join(f.rootDir, 'projects', 'p', 'state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  await expectCode(f.store.getState('p'), 'FOLDY_STATE_TOO_LARGE');
});

test('prepareProject mkdir traversal cannot create through a replaced storage ancestor', async () => {
  const f = await fixture();
  const outside = path.join(f.tempDir, 'outside-mkdir-race');
  await mkdir(outside);
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeStorageMutation: async (operation, target) => {
        if (raced || operation !== 'mkdir' || target !== path.join(f.rootDir, 'projects')) return;
        raced = true;
        await rename(f.rootDir, `${f.rootDir}.displaced`);
        await symlink(outside, f.rootDir);
      },
    },
  });

  await expectCode(store.getState('p'), 'FOLDY_UNSAFE_STORAGE');
  assert.equal(raced, true);
  assert.deepEqual(await readdir(outside), []);
});

test('lock acquisition cannot write through a replaced project ancestor', async () => {
  const f = await fixture();
  await f.store.getState('p');
  const projectDir = path.join(f.rootDir, 'projects', 'p');
  const outside = path.join(f.tempDir, 'outside-lock-acquire-race');
  await mkdir(outside);
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeStorageMutation: async (operation) => {
        if (raced || operation !== 'lock-acquire') return;
        raced = true;
        await rename(projectDir, `${projectDir}.displaced`);
        await symlink(outside, projectDir);
      },
    },
  });

  await expectCode(store.getState('p'), 'FOLDY_UNSAFE_STORAGE');
  assert.equal(raced, true);
  assert.deepEqual(await readdir(outside), []);
});

test('stale lock recovery cannot delete through a replaced project ancestor', async () => {
  const f = await fixture();
  await f.store.getState('p');
  const projectDir = path.join(f.rootDir, 'projects', 'p');
  const locksDir = path.join(projectDir, '.publication-locks');
  const token = '123e4567-e89b-12d3-a456-426614174000';
  const owner = JSON.stringify({ pid: 999_999_999, token, acquiredAt: '2020-01-01T00:00:00.000Z' });
  const ownerPath = path.join(locksDir, `owner.${token}.json`);
  await writeFile(ownerPath, owner);
  await link(ownerPath, path.join(locksDir, 'held'));
  await utimes(path.join(locksDir, 'held'), new Date(0), new Date(0));
  const outside = path.join(f.tempDir, 'outside-lock-recovery-race');
  await mkdir(outside);
  await writeFile(path.join(outside, 'held'), 'outside sentinel');
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeStorageMutation: async (operation) => {
        if (raced || operation !== 'lock-recover') return;
        raced = true;
        await rename(projectDir, `${projectDir}.displaced`);
        await symlink(outside, projectDir);
      },
    },
  });

  await expectCode(store.getState('p'), 'FOLDY_UNSAFE_STORAGE');
  assert.equal(raced, true);
  assert.equal(await readFile(path.join(outside, 'held'), 'utf8'), 'outside sentinel');
});

test('lock release cannot delete through a replaced project ancestor', async () => {
  const f = await fixture();
  await f.store.getState('p');
  const projectDir = path.join(f.rootDir, 'projects', 'p');
  const outside = path.join(f.tempDir, 'outside-lock-release-race');
  await mkdir(outside);
  await writeFile(path.join(outside, 'held'), 'outside sentinel');
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeStorageMutation: async (operation) => {
        if (raced || operation !== 'lock-release') return;
        raced = true;
        await rename(projectDir, `${projectDir}.displaced`);
        await symlink(outside, projectDir);
      },
    },
  });

  await expectCode(store.getState('p'), 'FOLDY_UNSAFE_STORAGE');
  assert.equal(raced, true);
  assert.equal(await readFile(path.join(outside, 'held'), 'utf8'), 'outside sentinel');
});

test('receipt temp cleanup cannot delete through a replaced transitions ancestor', async () => {
  const f = await fixture();
  await f.store.getState('p');
  const transitionsDir = path.join(f.rootDir, 'projects', 'p', 'transitions');
  const tempName = '.receipt.json.123.123e4567-e89b-12d3-a456-426614174000.tmp';
  await mkdir(transitionsDir, { recursive: true });
  await writeFile(path.join(transitionsDir, tempName), 'inside abandoned');
  const outside = path.join(f.tempDir, 'outside-receipt-cleanup-race');
  await mkdir(outside);
  await writeFile(path.join(outside, tempName), 'outside sentinel');
  let raced = false;
  const store = new FoldyPublicationStore({
    rootDir: f.rootDir,
    testHooks: {
      beforeStorageMutation: async (operation) => {
        if (raced || operation !== 'receipt-temp-cleanup') return;
        raced = true;
        await rename(transitionsDir, `${transitionsDir}.displaced`);
        await symlink(outside, transitionsDir);
      },
    },
  });

  await expectCode(store.getState('p'), 'FOLDY_UNSAFE_STORAGE');
  assert.equal(raced, true);
  assert.equal(await readFile(path.join(outside, tempName), 'utf8'), 'outside sentinel');
});
