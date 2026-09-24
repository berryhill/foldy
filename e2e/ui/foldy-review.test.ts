import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const runtime = resolve('../apps/foldy-runtime');

test('owner understands changed pages and text before inspecting isolated previews', async ({ page, context }) => {
  const unexpected: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://evil.invalid/')) unexpected.push(request.url()); });
  const dir = mkdtempSync(join(tmpdir(), 'foldy-review-'));
  let child: ChildProcess | undefined;
  try {
    const bundle = join(dir, 'bundle');
    mkdirSync(bundle);
    mkdirSync(join(dir, 'state'), { mode: 0o700 });
    const files = {
      'index.html': '<h1>Welcome</h1><p>Original introductory sentence.</p>',
      'old.html': '<h1>Old guide</h1><p>Former instructions.</p>',
    };
    const members = Object.entries(files).map(([path, content]) => {
      writeFileSync(join(bundle, path), content);
      return { path, mediaType: 'text/html', bytes: Buffer.byteLength(content), sha256: digest(content), executableMode: 0 };
    });
    const manifest = JSON.stringify({ schemaVersion: 'foldy-release-bundle.v1', instanceId: 'instance-1', projectId: 'project-1', workbookId: 'workbook-1', revisionId: 'revision-1', runtimeImageDigest: `sha256:${'a'.repeat(64)}`, members });
    writeFileSync(join(bundle, 'manifest.json'), manifest);
    const assertion = randomBytes(32).toString('hex');
    writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify({ instanceId: 'instance-1', verifier: digest(assertion), expiresAt: Date.now() + 600000 }), { mode: 0o600 });
    child = spawn(process.execPath, [resolve(runtime, 'dist/main.js')], {
      cwd: runtime,
      env: { ...process.env, FOLDY_BUNDLE_DIR: bundle, FOLDY_BUNDLE_DIGEST: digest(manifest), FOLDY_STATE_DIR: join(dir, 'state'), FOLDY_BOOTSTRAP_FILE: join(dir, 'bootstrap.json'), FOLDY_DEV_LOOPBACK: '1', FOLDY_PORT: '0', FOLDY_EXTERNAL_CACHE_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout?.on('data', data => { logs += data.toString(); });
    child.stderr?.on('data', data => { logs += data.toString(); });
    let port: string | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      port = logs.match(/FOLDY_LISTENING (\d+)/)?.[1];
      if (port || child.exitCode !== null) break;
      await new Promise(done => setTimeout(done, 25));
    }
    if (!port) throw new Error('local synthetic runtime did not start: ' + logs.replaceAll(assertion, '[REDACTED]'));
    const url = `http://127.0.0.1:${port}`;
    const claim = await context.request.post(url + '/api/claim', { data: { assertion }, headers: { origin: url } });
    expect(claim.status()).toBe(200);
    const ownerCookie = claim.headers()['set-cookie']?.split(';')[0];
    expect(ownerCookie).toBeTruthy();
    const operation = async (name: string, args: Record<string, unknown>) => {
      const response = await context.request.post(url + '/api/operations', { data: { name, arguments: args }, headers: { origin: url, cookie: ownerCookie! } });
      expect(response.status(), name).toBe(200);
      return response.json();
    };
    const created = await operation('create_update', { projectId: 'project-1', expectedBaseRevisionId: 'revision-1', title: 'Update the guide', idempotencyKey: 'create' });
    let revision: string = created.updateRevisionId;
    const ref = { projectId: 'project-1', expectedBaseRevisionId: 'revision-1', updateId: created.updateId };
    for (const [name, path, content] of [
      ['update_page', 'index.html', '<h1>Start here</h1><p>Clear steps for new readers.</p><script>window.injected = true</script><img src="https://evil.invalid/leak">'],
      ['remove_page', 'old.html', ''],
      ['create_page', 'new.html', '<h1>New guide</h1><p>Read the new guide first.</p>'],
    ] as const) {
      const receipt = await operation(name, { ...ref, expectedUpdateRevisionId: revision, path, ...(name === 'remove_page' ? {} : { content }), ...(name === 'create_page' ? { mediaType: 'text/html' } : {}), idempotencyKey: name });
      revision = receipt.updateRevisionId;
    }
    // Loopback HTTP cannot store the production Secure owner cookie; send it
    // explicitly for this isolated browser context without weakening runtime auth.
    await context.setExtraHTTPHeaders({ cookie: ownerCookie! });
    await page.goto(url + '/owner');
    await page.getByRole('button', { name: 'Review update' }).click();
    const summary = page.getByRole('region', { name: 'Change summary' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Edited: index.html');
    await expect(summary).toContainText('Added: new.html');
    await expect(summary).toContainText('Removed: old.html');
    await expect(summary).toContainText('Welcome');
    await expect(summary).toContainText('Start here');
    await expect(summary).toContainText('Original introductory sentence.');
    await expect(summary).toContainText('Clear steps for new readers.');
    await expect(summary).toContainText('New guide');
    await expect(summary).toContainText('Old guide');
    const order = await page.locator('main').evaluate(el => ({ summary: el.querySelector('[aria-label="Change summary"]')?.getBoundingClientRect().top, frame: el.querySelector('iframe')?.getBoundingClientRect().top }));
    expect(order.summary).toBeLessThan(order.frame!);
    expect(await page.locator('main script').count()).toBe(0);
    expect(await page.locator('iframe').first().getAttribute('sandbox')).toBe('');
    expect(await page.evaluate(() => (window as typeof window & { injected?: boolean }).injected)).toBeUndefined();
    expect(unexpected).toEqual([]);
    await expect(page.getByRole('button', { name: 'Approve this version' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Request review' })).toHaveCount(0);
    await page.getByText('Readiness evidence', { exact: true }).click();
    await expect(page.getByText(/Dependencies: Failed/)).toBeVisible();
    const repaired = await operation('update_page', { ...ref, expectedUpdateRevisionId: revision, path: 'index.html', content: '<h1>Start here</h1><p>Clear steps for new readers.</p>', idempotencyKey: 'repair' });
    revision = repaired.updateRevisionId;
    await page.goto(url + '/owner');
    await page.getByRole('button', { name: 'Review update' }).click();
    await expect(page.getByRole('region', { name: 'Change summary' })).toContainText('Edited: index.html');
    await expect(page.getByRole('button', { name: 'Request review' })).toBeVisible();
  } finally {
    if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    rmSync(dir, { recursive: true, force: true });
  }
});
