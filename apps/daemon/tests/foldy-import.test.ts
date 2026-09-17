import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adoptFoldyImport, preflightFoldyImport, type FoldyProjectMetadata } from '../src/foldy-promotion.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'foldy-import-')); roots.push(root);
  const source = JSON.stringify({ workbookId: 'book', revisions: [{ revisionId: 'source-frozen', state: 'FROZEN', protectedSurfaces: [{ path: '.source-control', sha256: 'a'.repeat(64) }], review: 'source-only' }] });
  await writeFile(path.join(root, 'index.html'), '<h1>Imported</h1>');
  await writeFile(path.join(root, 'workbook.json'), source);
  await mkdir(path.join(root, 'revisions/source-frozen'), { recursive: true });
  await writeFile(path.join(root, 'revisions/source-frozen/evidence'), 'untouched');
  let metadata: FoldyProjectMetadata = { kind: 'prototype', importedFrom: 'folder', baseDir: root, entryFile: 'index.html' };
  const options = { projectId: 'target', projectRoot: root, readProjectMetadata: () => metadata,
    compareAndSetProjectMetadata: (expected: FoldyProjectMetadata, replacement: FoldyProjectMetadata) => { if (expected !== metadata) return false; metadata = replacement; return true; } };
  const preflight = await preflightFoldyImport(options);
  return { root, source, options, request: { ...preflight, confirmExactContent: true }, metadata: () => metadata };
}
test('adopts historical frozen import without sidecar, source mutations, or approval authority', async () => {
  const f = await fixture(); const result = await adoptFoldyImport({ ...f.options, request: f.request });
  expect(result.currentRevisionId).not.toBe('source-frozen');
  expect(await readFile(path.join(f.root, 'workbook.json'), 'utf8')).toBe(f.source);
  expect(await readFile(path.join(f.root, 'index.html'), 'utf8')).toBe('<h1>Imported</h1>');
  expect(await readFile(path.join(f.root, 'revisions/source-frozen/evidence'), 'utf8')).toBe('untouched');
  const baseline = JSON.parse(await readFile(path.join(f.root, `revisions/${result.currentRevisionId}/workbook.json`), 'utf8'));
  expect(baseline.revisions.at(-1)).toMatchObject({ state: 'FROZEN', snapshotKind: 'imported-html-snapshot' });
  expect(baseline.revisions.at(-1).review).toBeUndefined();
  const control = JSON.parse(await readFile(path.join(f.root, result.controlPath), 'utf8'));
  expect(control).toMatchObject({ projectId: 'target', importedRootSha256: f.request.importedRootSha256 });
  expect(f.metadata().publicationFiles).toEqual(['index.html', 'workbook.json']);
  await expect(adoptFoldyImport({ ...f.options, request: f.request })).rejects.toMatchObject({ code: 'FOLDY_IMPORT_ALREADY_ENROLLED' });
});
test('rejects stale exact bytes and missing confirmation without writes', async () => {
  const f = await fixture();
  await expect(adoptFoldyImport({ ...f.options, request: { ...f.request, confirmExactContent: false } })).rejects.toMatchObject({ code: 'FOLDY_INVALID_REQUEST' });
  await writeFile(path.join(f.root, 'index.html'), 'changed');
  await expect(adoptFoldyImport({ ...f.options, request: f.request })).rejects.toMatchObject({ code: 'FOLDY_IMPORT_STALE' });
  expect(await readdir(path.join(f.root, 'revisions'))).toEqual(['source-frozen']);
});
test('CAS failure rolls back only newly created baseline/control', async () => {
  const f = await fixture();
  await expect(adoptFoldyImport({ ...f.options, request: f.request, compareAndSetProjectMetadata: () => false })).rejects.toMatchObject({ code: 'FOLDY_METADATA_CAS_FAILED' });
  expect(await readdir(path.join(f.root, 'revisions'))).toEqual(['source-frozen']);
  expect((await readdir(f.root)).filter((name) => name.startsWith('.foldy'))).toEqual([]);
  expect(await readFile(path.join(f.root, 'workbook.json'), 'utf8')).toBe(f.source);
});
test('rejects symlink input and symlink baseline parent', async () => {
  const f = await fixture();
  await rm(path.join(f.root, 'index.html')); await symlink('workbook.json', path.join(f.root, 'index.html'));
  await expect(preflightFoldyImport(f.options)).rejects.toMatchObject({ code: 'FOLDY_PATH_ESCAPE' });
  await rm(path.join(f.root, 'index.html')); await writeFile(path.join(f.root, 'index.html'), '<h1>Imported</h1>');
  await rm(path.join(f.root, 'revisions'), { recursive: true }); await symlink('.', path.join(f.root, 'revisions'));
  await expect(adoptFoldyImport({ ...f.options, request: f.request })).rejects.toMatchObject({ code: 'FOLDY_PATH_ESCAPE' });
});
test('concurrent adoption has one winner', async () => {
  const f = await fixture(); const results = await Promise.allSettled([1, 2].map(() => adoptFoldyImport({ ...f.options, request: f.request })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});

test('metadata drift and non-null heads cannot be adopted', async () => {
  const f = await fixture(); f.metadata().name = 'changed';
  await expect(adoptFoldyImport({ ...f.options, request: f.request })).rejects.toMatchObject({ code: 'FOLDY_IMPORT_STALE' });
  f.metadata().currentRevisionId = 'existing';
  await expect(preflightFoldyImport(f.options)).rejects.toMatchObject({ code: 'FOLDY_IMPORT_ALREADY_ENROLLED' });
});

test('binds script and CSS dependencies and rejects dependency drift', async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, 'assets'));
  await writeFile(path.join(f.root, 'index.html'), '<script src="assets/app.js"></script><link rel="stylesheet" href="assets/site.css">');
  await writeFile(path.join(f.root, 'assets/app.js'), 'console.log("original")');
  await writeFile(path.join(f.root, 'assets/site.css'), 'body { color: red; }');
  const preflight = await preflightFoldyImport(f.options);
  expect(preflight.rootFiles.map((file) => file.path)).toContain('assets/app.js');
  expect(preflight.rootFiles.map((file) => file.path)).toContain('assets/site.css');
  await writeFile(path.join(f.root, 'assets/app.js'), 'console.log("changed")');
  await expect(adoptFoldyImport({ ...f.options, request: { ...preflight, confirmExactContent: true } })).rejects.toMatchObject({ code: 'FOLDY_IMPORT_STALE' });
  const refreshed = await preflightFoldyImport(f.options);
  const result = await adoptFoldyImport({ ...f.options, request: { ...refreshed, confirmExactContent: true } });
  expect(await readFile(path.join(f.root, `revisions/${result.currentRevisionId}/assets/app.js`), 'utf8')).toBe('console.log("changed")');
  expect(f.metadata().publicationFiles).toContain('assets/site.css');
});

test('attempts baseline rollback even if control cleanup fails', async () => {
  const f = await fixture();
  await expect(adoptFoldyImport({ ...f.options, request: f.request, compareAndSetProjectMetadata: async () => {
    const control = (await readdir(f.root)).find((name) => name.startsWith('.foldy-import-control-'))!;
    await rm(path.join(f.root, control));
    await mkdir(path.join(f.root, control));
    return false;
  } })).rejects.toMatchObject({ code: 'FOLDY_IMPORT_ROLLBACK_FAILED' });
  expect(await readdir(path.join(f.root, 'revisions'))).toEqual(['source-frozen']);
  expect(f.metadata().foldy).toBeUndefined();
});
