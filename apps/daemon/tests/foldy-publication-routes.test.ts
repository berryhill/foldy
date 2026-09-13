import type http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { FoldyPublicationStore } from '../src/foldy-publications/store.js';
import { registerFoldyPublicationRoutes } from '../src/routes/foldy-publication.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function fixture(
  metadata: Record<string, unknown> = { foldy: true, entryFile: 'index.html', publicationFiles: ['assets/app.css'] },
  resolveActorId: () => string | Promise<string> = async () => 'server-member',
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foldy-publication-routes-'));
  const projectRoot = path.join(tempDir, 'working');
  await mkdir(path.join(projectRoot, 'assets'), { recursive: true });
  await writeFile(path.join(projectRoot, 'index.html'), '<h1>revision one</h1>');
  await writeFile(path.join(projectRoot, 'assets', 'app.css'), 'body { color: red; }');

  let id = 0;
  const publicationStore = new FoldyPublicationStore({
    rootDir: path.join(tempDir, 'publication-store'),
    randomId: () => `id_${++id}`,
  });
  const app = express();
  app.use(express.json());
  registerFoldyPublicationRoutes(app, {
    foldyPublication: {
      publicationStore,
      resolveProject: (projectId: string) => projectId === 'foldy-one'
        ? { id: projectId, metadata }
        : null,
      resolveProjectRoot: () => projectRoot,
      resolveActorId,
    },
  });
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });
  const json = (url: string, init?: RequestInit) => fetch(`${baseUrl}${url}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  return { baseUrl, json, projectRoot };
}

async function responseJson(response: Response): Promise<any> {
  return response.json();
}

describe('fork-native Foldy publication routes', () => {
  it('derives a bounded recursive publication closure for formal Foldys without publicationFiles', async () => {
    const f = await fixture({ foldy: true, entryFile: 'index.html' });
    await mkdir(path.join(f.projectRoot, 'styles', 'nested'), { recursive: true });
    await mkdir(path.join(f.projectRoot, 'assets', 'fonts'), { recursive: true });
    await mkdir(path.join(f.projectRoot, 'scripts', 'modules'), { recursive: true });
    await mkdir(path.join(f.projectRoot, 'pages'), { recursive: true });
    await writeFile(path.join(f.projectRoot, 'index.html'), [
      '<link rel="stylesheet" href="./styles/site.css?theme=dark#v1">',
      '<script type="module" src="./scripts/app.js"></script>',
      '<a href="./pages/about.html">About</a>',
      '<img srcset="./assets/hero.png 1x, https://cdn.example/hero.png 2x, data:image/png;base64,AAAA 3x">',
      '<img src="../../../outside.png"><script src="https://cdn.example/app.js"></script>',
    ].join(''));
    await writeFile(path.join(f.projectRoot, 'styles', 'site.css'), [
      '@import "./nested/colors.css";',
      '@font-face { src: url("../assets/fonts/site.woff2") format("woff2"); }',
      '.hero { background: url(../assets/bg.png#hero); }',
      '.ignored { background: url(data:image/png;base64,AAAA); }',
    ].join(''));
    await writeFile(path.join(f.projectRoot, 'styles', 'nested', 'colors.css'), ':root { --brand: red; }');
    await writeFile(path.join(f.projectRoot, 'scripts', 'app.js'), [
      'import { boot } from "./modules/boot.js";',
      'export { version } from "./modules/version.js";',
      'import("https://cdn.example/lazy.js");',
      'boot();',
    ].join('\n'));
    await writeFile(path.join(f.projectRoot, 'scripts', 'modules', 'boot.js'), 'export const boot = () => {};');
    await writeFile(path.join(f.projectRoot, 'scripts', 'modules', 'version.js'), 'export const version = 1;');
    await writeFile(path.join(f.projectRoot, 'pages', 'about.html'), '<h1>About</h1>');
    await writeFile(path.join(f.projectRoot, 'assets', 'hero.png'), 'hero');
    await writeFile(path.join(f.projectRoot, 'assets', 'bg.png'), 'background');
    await writeFile(path.join(f.projectRoot, 'assets', 'fonts', 'site.woff2'), 'font');
    await writeFile(path.join(f.projectRoot, 'unrelated.txt'), 'must not publish');

    const revisionResponse = await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    });
    expect(revisionResponse.status).toBe(201);
    const revision = await responseJson(revisionResponse);
    const expectedPaths = [
      'assets/bg.png',
      'assets/fonts/site.woff2',
      'assets/hero.png',
      'index.html',
      'pages/about.html',
      'scripts/app.js',
      'scripts/modules/boot.js',
      'scripts/modules/version.js',
      'styles/nested/colors.css',
      'styles/site.css',
    ];
    expect(revision.files.map((file: { path: string }) => file.path)).toEqual(expectedPaths);
    expect(revision.files.map((file: { path: string }) => file.path)).not.toContain('unrelated.txt');

    const review = await responseJson(await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}/review`, {
      method: 'POST', body: JSON.stringify({ expectedLatestRevisionId: revision.revisionId }),
    }));
    await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}/reviews/${review.reviewId}/decision`, {
      method: 'POST', body: JSON.stringify({ decision: 'approved', expectedReviewVersion: 1 }),
    });
    await f.json('/api/projects/foldy-one/publication/publish', {
      method: 'POST', body: JSON.stringify({ revisionId: revision.revisionId, expectedPublishedGeneration: 0 }),
    });
    for (const filePath of expectedPaths) {
      const served = await fetch(`${f.baseUrl}/p/foldy-one/${filePath}`);
      expect(served.status, filePath).toBe(200);
    }
    for (const excludedPath of ['unrelated.txt', 'outside.png']) {
      expect((await fetch(`${f.baseUrl}/p/foldy-one/${excludedPath}`)).status, excludedPath).toBe(404);
    }
  });

  it('rejects direct API publication without an approved review for that exact revision', async () => {
    const f = await fixture();
    const revision = await responseJson(await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    }));
    const response = await f.json('/api/projects/foldy-one/publication/publish', {
      method: 'POST', body: JSON.stringify({ revisionId: revision.revisionId, expectedPublishedGeneration: 0 }),
    });
    expect(response.status).toBe(409);
    expect(await responseJson(response)).toMatchObject({ error: { code: 'FOLDY_APPROVAL_REQUIRED' } });
    expect(await responseJson(await f.json('/api/projects/foldy-one/publication'))).toMatchObject({ publishedRevisionId: null, publishedGeneration: 0 });
  });

  it('runs revision, review, comment, decision, publish and rollback with a server-derived actor', async () => {
    const f = await fixture();
    const publication = await f.json('/api/projects/foldy-one/publication');
    expect(publication.status).toBe(200);
    expect(await responseJson(publication)).toMatchObject({ projectId: 'foldy-one', latestRevisionId: null, publishedGeneration: 0 });

    const revisionResponse = await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST',
      body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null, actorId: 'body-attacker' }),
    });
    expect(revisionResponse.status).toBe(201);
    const revision = await responseJson(revisionResponse);
    expect(revision).toMatchObject({ revisionId: 'id_1', createdBy: 'server-member', entryFile: 'index.html' });

    const getRevision = await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}`);
    expect(getRevision.status).toBe(200);
    expect(await responseJson(getRevision)).toEqual(revision);

    const reviewResponse = await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}/review`, {
      method: 'POST',
      body: JSON.stringify({ expectedLatestRevisionId: revision.revisionId, actorId: 'body-attacker' }),
    });
    expect(reviewResponse.status).toBe(201);
    const review = await responseJson(reviewResponse);
    expect(review).toMatchObject({ reviewId: 'id_2', requestedBy: 'server-member', version: 1 });

    const commentResponse = await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}/reviews/${review.reviewId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Ship it.', expectedReviewVersion: 1, actorId: 'body-attacker' }),
    });
    expect(commentResponse.status).toBe(201);
    expect(await responseJson(commentResponse)).toMatchObject({ body: 'Ship it.', createdBy: 'server-member' });

    const decisionResponse = await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}/reviews/${review.reviewId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', expectedReviewVersion: 2, actorId: 'body-attacker' }),
    });
    expect(decisionResponse.status).toBe(200);
    expect(await responseJson(decisionResponse)).toMatchObject({ status: 'approved', decidedBy: 'server-member', version: 3 });

    const publishResponse = await f.json('/api/projects/foldy-one/publication/publish', {
      method: 'POST',
      body: JSON.stringify({ revisionId: revision.revisionId, expectedPublishedGeneration: 0, actorId: 'body-attacker' }),
    });
    expect(publishResponse.status).toBe(200);
    expect(await responseJson(publishResponse)).toMatchObject({ kind: 'publish', publishedBy: 'server-member', generation: 1 });

    const rollbackResponse = await f.json('/api/projects/foldy-one/publication/rollback', {
      method: 'POST',
      body: JSON.stringify({ targetRevisionId: revision.revisionId, expectedPublishedGeneration: 1, actorId: 'body-attacker' }),
    });
    expect(rollbackResponse.status).toBe(200);
    expect(await responseJson(rollbackResponse)).toMatchObject({ kind: 'rollback', publishedBy: 'server-member', generation: 2 });
  });

  it('serves root and manifest paths with publication isolation and no-store caching', async () => {
    const metadata: Record<string, unknown> = {
      foldy: true,
      entryFile: 'index.html',
      publicationFiles: ['assets/app.css', 'attack.svg', 'attack.xhtml'],
    };
    const f = await fixture(metadata);
    await writeFile(path.join(f.projectRoot, 'attack.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
    await writeFile(path.join(f.projectRoot, 'attack.xhtml'), '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(document.domain)</script></html>');
    const revisionResponse = await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST',
      body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    });
    const revision = await responseJson(revisionResponse);
    const review = await responseJson(await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}/review`, {
      method: 'POST', body: JSON.stringify({ expectedLatestRevisionId: revision.revisionId }),
    }));
    await f.json(`/api/projects/foldy-one/revisions/${revision.revisionId}/reviews/${review.reviewId}/decision`, {
      method: 'POST', body: JSON.stringify({ decision: 'approved', expectedReviewVersion: 1 }),
    });
    await f.json('/api/projects/foldy-one/publication/publish', {
      method: 'POST', body: JSON.stringify({ revisionId: revision.revisionId, expectedPublishedGeneration: 0 }),
    });

    await writeFile(path.join(f.projectRoot, 'index.html'), '<h1>working copy changed</h1>');
    await writeFile(path.join(f.projectRoot, 'not-published.txt'), 'secret working byte');

    const publicResponse = await fetch(`${f.baseUrl}/p/foldy-one/index.html`);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toBe('<h1>revision one</h1>');
    expect(publicResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(publicResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(publicResponse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(publicResponse.headers.get('etag')).toBeNull();
    const csp = publicResponse.headers.get('content-security-policy');
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");

    const conditional = await fetch(`${f.baseUrl}/p/foldy-one/index.html`, {
      headers: { 'if-none-match': '"sha256-stale-shared-cache-validator"' },
    });
    expect(conditional.status).toBe(200);
    expect(await conditional.text()).toBe('<h1>revision one</h1>');

    metadata.entryFile = 'working-copy-entry.html';
    for (const rootPath of ['/p/foldy-one', '/p/foldy-one/']) {
      const rootResponse = await fetch(`${f.baseUrl}${rootPath}`);
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.headers.get('content-type')).toContain('text/html');
      expect(rootResponse.headers.get('cache-control')).toBe('private, no-store');
      expect(rootResponse.headers.get('x-content-type-options')).toBe('nosniff');
      expect(rootResponse.headers.get('referrer-policy')).toBe('no-referrer');
      expect(rootResponse.headers.get('content-security-policy')).toBe(csp);
      expect(await rootResponse.text()).toBe('<h1>revision one</h1>');
    }

    const assetResponse = await fetch(`${f.baseUrl}/p/foldy-one/assets/app.css`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(assetResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(assetResponse.headers.get('content-security-policy')).toBeNull();
    expect(assetResponse.headers.get('referrer-policy')).toBeNull();
    expect(await assetResponse.text()).toBe('body { color: red; }');

    for (const activePath of ['attack.svg', 'attack.xhtml']) {
      const activeResponse = await fetch(`${f.baseUrl}/p/foldy-one/${activePath}`);
      expect(activeResponse.status).toBe(200);
      expect(activeResponse.headers.get('cache-control')).toBe('private, no-store');
      expect(activeResponse.headers.get('x-content-type-options')).toBe('nosniff');
      expect(activeResponse.headers.get('referrer-policy')).toBe('no-referrer');
      expect(activeResponse.headers.get('content-security-policy')).toBe(csp);
      expect(await activeResponse.text()).toContain('alert(document.domain)');
    }

    const unmanifested = await fetch(`${f.baseUrl}/p/foldy-one/not-published.txt`);
    expect(unmanifested.status).toBe(404);
    expect(unmanifested.headers.get('cache-control')).toBe('private, no-store');
    expect(unmanifested.headers.get('x-content-type-options')).toBe('nosniff');

    const malformed = await fetch(`${f.baseUrl}/p/foldy-one/%ZZ`);
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('cache-control')).toBe('private, no-store');
    expect(malformed.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('propagates authorization resolution failure as a typed 403 without mutating state', async () => {
    const f = await fixture(undefined, async () => {
      const error = new Error('workspace project access is not allowed') as Error & { status: number; code: string };
      error.status = 403;
      error.code = 'WORKSPACE_PROJECT_PERMISSION_DENIED';
      throw error;
    });
    const response = await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    });
    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({ error: {
      code: 'WORKSPACE_PROJECT_PERMISSION_DENIED', message: 'workspace project access is not allowed',
    } });
    const state = await f.json('/api/projects/foldy-one/publication');
    expect(await responseJson(state)).toMatchObject({ latestRevisionId: null });
  });

  it('publishes only explicitly enrolled public files and rejects unsafe declarations', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, '.env'), 'DO_NOT_DISCLOSE');
    await writeFile(path.join(f.projectRoot, 'credentials.json'), 'DO_NOT_DISCLOSE');
    await mkdir(path.join(f.projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(f.projectRoot, 'src', 'private.ts'), 'DO_NOT_DISCLOSE');
    await writeFile(path.join(f.projectRoot, 'notes.txt'), 'DO_NOT_DISCLOSE');
    const response = await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    });
    const revision = await responseJson(response);
    expect(revision.files.map((file: { path: string }) => file.path)).toEqual(['assets/app.css', 'index.html']);
    expect(JSON.stringify(revision)).not.toContain('DO_NOT_DISCLOSE');

    const unsafe = await fixture({ foldy: true, entryFile: 'index.html', publicationFiles: ['.env'] });
    await writeFile(path.join(unsafe.projectRoot, '.env'), 'DO_NOT_DISCLOSE');
    const rejected = await unsafe.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    });
    expect(rejected.status).toBe(422);
    expect(await responseJson(rejected)).toMatchObject({ error: { code: 'FOLDY_PUBLICATION_FILE_UNSAFE' } });
  });

  it('fails closed for non-Foldy projects, mismatched enrolled entries, invalid bodies, and typed CAS conflicts', async () => {
    const notFoldy = await fixture({ entryFile: 'index.html' });
    const rejected = await notFoldy.json('/api/projects/foldy-one/publication');
    expect(rejected.status).toBe(404);
    expect(await responseJson(rejected)).toMatchObject({ error: { code: 'FOLDY_PROJECT_NOT_FOUND' } });

    const f = await fixture();
    const mismatchedEntry = await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'other.html', expectedLatestRevisionId: null }),
    });
    expect(mismatchedEntry.status).toBe(422);
    expect(await responseJson(mismatchedEntry)).toMatchObject({ error: { code: 'FOLDY_ENTRY_IDENTITY_MISMATCH' } });

    const malformed = await f.json('/api/projects/foldy-one/publication/publish', {
      method: 'POST', body: JSON.stringify({ revisionId: '', expectedPublishedGeneration: -1 }),
    });
    expect(malformed.status).toBe(400);
    expect(await responseJson(malformed)).toMatchObject({ error: { code: 'FOLDY_INVALID_REQUEST' } });

    const first = await responseJson(await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    }));
    const conflict = await f.json('/api/projects/foldy-one/revisions', {
      method: 'POST', body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: null }),
    });
    expect(first.revisionId).toBeTruthy();
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toMatchObject({ error: { code: 'FOLDY_LATEST_REVISION_CONFLICT' } });
  });
});
