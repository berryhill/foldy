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

  it('serves only immutable manifest-addressed published bytes with a strong ETag', async () => {
    const f = await fixture();
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
    const etag = publicResponse.headers.get('etag');
    expect(etag).toMatch(/^"sha256-[a-f0-9]{64}"$/);
    expect(publicResponse.headers.get('cache-control')).toBe('public, no-cache, must-revalidate');

    const conditional = await fetch(`${f.baseUrl}/p/foldy-one/index.html`, { headers: { 'if-none-match': etag! } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');

    const unmanifested = await fetch(`${f.baseUrl}/p/foldy-one/not-published.txt`);
    expect(unmanifested.status).toBe(404);
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
