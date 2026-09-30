import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { randomBytes, randomUUID } from 'node:crypto';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

async function check(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(n => n.target) }))).toEqual([]);
}

test('claim, review and password unlock have accessible landmarks, labels and contrast at desktop and 390px', async ({ browser }, info) => {
  const runtime = await startFoldy();
  const owner = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
  const viewer = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await owner.newPage();
  const reader = await viewer.newPage();
  try {
    await page.goto(runtime.url + '/owner');
    await expect(page.getByRole('heading', { name: 'Claim your Foldy' })).toBeVisible();
    await check(page);
    await page.getByLabel('One-use owner key').fill(runtime.assertion);
    await page.getByLabel('New owner password').fill(randomBytes(24).toString('hex'));
    await page.getByRole('button', { name: 'Claim ownership' }).click();
    await expect(page.getByRole('heading', { name: 'Review what’s next' })).toBeVisible();
    await check(page);
    const base = { projectId: 'project-1', expectedBaseRevisionId: 'revision-1' };
    const created = await owner.request.post(runtime.url + '/api/operations', { headers: { origin: runtime.url }, data: { name: 'create_update', arguments: { ...base, title: 'Accessible proposal', idempotencyKey: randomUUID() } } });
    expect(created.status()).toBe(200);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Review update' }).click();
    await expect(page.getByRole('heading', { name: 'Accessible proposal' })).toBeVisible();
    await check(page);
    const password = 'accessible-viewer-password-not-a-credential';
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'All updates' }).click();
    await page.getByLabel('New viewing password').fill(password);
    const configured = page.waitForResponse(r => r.url().endsWith('/api/owner/viewer-access') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Require password' }).click();
    expect((await configured).status()).toBe(200);
    await expect(page.getByRole('status')).toContainText('Viewing password saved');
    await reader.goto(runtime.url + '/unlock');
    await expect(reader.getByLabel('Viewing password', { exact: true })).toBeVisible();
    await check(reader);
  } finally {
    await owner.close(); await viewer.close(); await runtime.close(info.status !== info.expectedStatus);
  }
});
