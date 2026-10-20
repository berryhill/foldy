import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

test('browser pairing stays pending until an exact offline operator decision',async({browser},info)=>{
 const runtime=await startFoldy(),owner=await browser.newContext({ignoreHTTPSErrors:true}),recipient=await browser.newContext({ignoreHTTPSErrors:true}),other=await browser.newContext({ignoreHTTPSErrors:true});
 const page=await recipient.newPage(),oldPassword=randomBytes(24).toString('hex'),newPassword=randomBytes(24).toString('hex');
 try{
  const claimed=await owner.request.post(runtime.url+'/api/claim',{headers:{origin:runtime.url},data:{assertion:runtime.assertion,password:oldPassword}});expect(claimed.status()).toBe(200);
  await page.goto(runtime.url+'/owner/setup');
  await expect(page.getByRole('button',{name:'Request ownership of this browser'})).toBeVisible();
  const requestBox=await page.getByRole('button',{name:'Request ownership of this browser'}).boundingBox(),keyBox=await page.getByLabel('Protected one-use owner key').boundingBox();
  expect(requestBox&&keyBox&&requestBox.y<keyBox.y,'browser approval is the primary setup path, before the optional invitation-key form').toBe(true);
  await page.screenshot({path:info.outputPath('pairing-entry-desktop.png'),fullPage:true});
  expect(await recipient.cookies()).toEqual([]);
  await expect(page.getByText('This browser is not approved yet.')).toHaveCount(0);
  const bad=await recipient.request.post(runtime.url+'/api/owner/pairing/request',{data:{}});expect(bad.status()).toBe(403);
  await page.getByRole('button',{name:'Request ownership of this browser'}).focus();
  await page.keyboard.press('Enter');
  const reference=await page.getByText(/^Pending request reference:/).textContent();
  const requestId=reference?.match(/[a-f0-9]{64}/)?.[0];expect(requestId).toMatch(/^[a-f0-9]{64}$/);
  expect(page.url()).not.toContain(requestId!);
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);
  expect((await recipient.cookies()).some(cookie=>cookie.name==='__Host-foldy-pairing'&&cookie.secure&&cookie.httpOnly&&cookie.sameSite==='Strict')).toBe(true);
  for(const width of [1280,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.getByLabel('New owner password for approved browser').fill(newPassword);
  await page.getByLabel('Confirm new owner password').fill(newPassword);
  await page.getByRole('button',{name:'Complete approved browser setup'}).click();
  await expect(page.getByRole('status')).toContainText('key or password was not accepted');
  const candidate=async(context:typeof recipient,data:unknown)=>context.request.post(runtime.url+'/api/owner/pairing/complete',{headers:{origin:runtime.url,'sec-fetch-site':'same-origin'},data});
  expect((await candidate(other,{password:newPassword})).status()).toBe(401);
  expect((await candidate(recipient,{password:newPassword,requestId})).status()).toBe(400);
  expect((await candidate(recipient,{requestId})).status()).toBe(400);
  expect((await candidate(recipient,{})).status()).toBe(400);
  expect((await candidate(recipient,{password:newPassword})).status()).toBe(401);
  await runtime.restart();
  expect((await candidate(recipient,{password:newPassword})).status()).toBe(401);
  expect((await owner.request.get(runtime.url+'/api/readiness')).status()).toBe(200);
  const browserSecret=(await recipient.cookies()).find(c=>c.name==='__Host-foldy-pairing')!.value;
  expect(readFileSync(join(runtime.root,'state','owner-pairings',requestId+'.json'),'utf8').includes(browserSecret)).toBe(false);
  const granted=await owner.request.post(runtime.url+'/api/mcp-grants',{headers:{origin:runtime.url},data:{}});expect(granted.status()).toBe(201);
  const otherRequest=await other.request.post(runtime.url+'/api/owner/pairing/request',{headers:{origin:runtime.url,'sec-fetch-site':'same-origin'},data:{}});expect(otherRequest.status()).toBe(200);
  // Synthetic fixture only: the test harness is the independent OS operator.
  // No live recipient, approval channel, or production authorization is implied.
  await runtime.stop();
  const approved=JSON.parse(execFileSync(process.execPath,[resolve('../apps/foldy-runtime/dist/owner-pairing.js'),'--request-id',requestId!,'--state-dir',join(runtime.root,'state'),'--bundle-dir',runtime.bundle,'--bundle-digest',runtime.bundleDigest,'--recovery-file',join(runtime.root,'recovery.json')],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  expect(approved.status).toBe('approved');expect(approved.requestId).toBe(requestId);
  await runtime.restart();
  expect((await candidate(other,{password:newPassword})).status()).toBe(401);
  await page.reload();
  await page.getByLabel('New owner password for approved browser').fill(newPassword);
  await page.getByLabel('Confirm new owner password').fill(newPassword);
  await page.getByRole('button',{name:'Complete approved browser setup'}).click();
  await expect(page).toHaveURL(runtime.url+'/owner');
  await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  expect((await owner.request.get(runtime.url+'/api/readiness')).status()).toBe(401);
  expect((await recipient.request.get(runtime.url+'/api/mcp-grants')).status()).toBe(200);
  expect((await (await recipient.request.get(runtime.url+'/api/mcp-grants')).json()).grants).toEqual([]);
  expect((await recipient.cookies()).some(c=>c.name==='__Host-foldy-pairing')).toBe(false);
  const replay=()=>other.request.post(runtime.url+'/api/owner/pairing/complete',{headers:{origin:runtime.url,'sec-fetch-site':'same-origin',cookie:'__Host-foldy-pairing='+browserSecret},data:{password:newPassword}});
  expect((await replay()).status()).toBe(401);await runtime.restart();expect((await replay()).status()).toBe(401);
  expect((await owner.request.post(runtime.url+'/api/owner/login',{headers:{origin:runtime.url},data:{password:oldPassword}})).status()).toBe(401);
  expect((await recipient.request.get(runtime.url+'/api/readiness')).status()).toBe(200);
 }finally{await owner.close();await recipient.close();await other.close();await runtime.close(info.status!==info.expectedStatus);}
});
