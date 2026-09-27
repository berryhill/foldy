import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

test('password rotation denies prior viewer grant and old password without granting owner authority', async ({ browser }, info) => {
  const runtime = await startFoldy();
  const owner = await browser.newContext({ ignoreHTTPSErrors: true });
  const viewer = await browser.newContext({ ignoreHTTPSErrors: true });
  const oldVisitor = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await owner.newPage(), reader = await viewer.newPage(), prior = await oldVisitor.newPage();
  page.on('dialog', dialog => dialog.accept());
  const first = randomBytes(24).toString('hex'), replacement = randomBytes(24).toString('hex');
  try {
    await page.goto(runtime.url + '/owner');
    await page.getByLabel('One-use owner key').fill(runtime.assertion);
    await page.getByRole('button', { name: 'Claim ownership' }).click();
    await expect(page.getByRole('heading', { name: 'Review what’s next' })).toBeVisible();
    const configure = async (password: string) => {
      await page.getByLabel('New viewing password').fill(password);
      const response = page.waitForResponse(r => r.url().endsWith('/api/owner/viewer-access') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Require password' }).click();
      expect((await response).status()).toBe(200);
      await expect(page.getByRole('status')).toContainText('Viewing password saved');
    };
    await configure(first);
    expect((await oldVisitor.request.get(runtime.url + '/')).status()).toBe(401);
    await prior.goto(runtime.url + '/unlock');
    await prior.getByLabel('Viewing password', { exact: true }).fill(first);
    await prior.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(prior.getByRole('heading', { name: 'Immutable Foldy' })).toBeVisible();
    await configure(replacement);
    expect((await oldVisitor.request.get(runtime.url + '/')).status()).toBe(401);
    await prior.goto(runtime.url + '/unlock');
    await expect(prior.getByRole('heading', { name: 'Open this Foldy' })).toBeVisible();
    await reader.goto(runtime.url + '/unlock');
    await reader.getByLabel('Viewing password', { exact: true }).fill(first);
    await reader.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(reader.getByRole('status')).toContainText('not accepted');
    await reader.getByLabel('Viewing password', { exact: true }).fill(replacement);
    await reader.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(reader.getByRole('heading', { name: 'Immutable Foldy' })).toBeVisible();
    expect((await viewer.request.post(runtime.url + '/api/operations', { headers: { origin: runtime.url }, data: { name: 'list_updates', arguments: {} } })).status()).toBe(401);
    await page.getByRole('button', { name: 'Allow public reading' }).click();
    await expect(page.getByRole('status')).toContainText('Public reading is enabled.');
    expect((await oldVisitor.request.get(runtime.url + '/')).status()).toBe(200);
    await configure(first);
    expect((await oldVisitor.request.get(runtime.url + '/')).status()).toBe(401);
    await reader.goto(runtime.url + '/unlock');
    await expect(reader.getByRole('heading', { name: 'Open this Foldy' })).toBeVisible();
  } finally {
    await owner.close(); await viewer.close(); await oldVisitor.close(); await runtime.close(info.status !== info.expectedStatus);
  }
});
