import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

test('cross-site entry with Strict owner cookie requires same-origin continuation and explicit consent', async ({browser}, info) => {
 const runtime=await startFoldy();
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 const page=await context.newPage();
 let authorize='';
 const external=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<a href="${authorize.replaceAll('&','&amp;')}">Connect Foldy</a>`);});
 external.listen(0,'127.0.0.1');await once(external,'listening');
 const addr=external.address();if(!addr||typeof addr==='string')throw Error('No cross-site port');
 const callback=`http://127.0.0.1:${addr.port}/callback`;
 try {
  await page.goto(runtime.url+'/owner');
  await page.getByLabel('One-use owner key').fill(runtime.assertion);
  await page.getByRole('button',{name:'Claim ownership',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  expect((await context.cookies()).find(c=>c.name==='__Host-foldy-owner')?.sameSite).toBe('Strict');
  const registration=await context.request.post(runtime.url+'/oauth/register',{data:{client_name:'Browser client',redirect_uris:[callback]}});
  expect(registration.status()).toBe(201);const client=await registration.json();
  const verifier=randomBytes(32).toString('base64url');
  authorize=runtime.url+'/oauth/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:callback,resource:runtime.url+'/mcp',response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:'browser-test'});
  await page.goto(`http://localhost:${addr.port}`);
  const entered=page.waitForResponse(r=>r.url()===authorize);
  await page.getByRole('link',{name:'Connect Foldy'}).click();
  expect((await entered).headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading',{name:'Continue to owner authorization'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Authorize these permissions'})).toHaveCount(0);
  const continuation=await page.getByRole('link',{name:'Continue to authorization'}).getAttribute('href');
  await page.getByRole('link',{name:'Continue to authorization'}).click();
  await expect(page.getByRole('button',{name:'Authorize these permissions'})).toBeVisible();
  const ticket=await page.locator('[name=ticket]').inputValue();
  expect((await context.request.post(runtime.url+'/oauth/consent',{headers:{origin:'https://evil.invalid'},form:{ticket,decision:'allow'}})).status()).toBe(403);
  const denied=page.waitForResponse(r=>r.url()===runtime.url+'/oauth/consent');
  await page.getByRole('button',{name:'Deny',exact:true}).click({noWaitAfter:true});
  const response=await denied;expect(response.status()).toBe(303);expect(response.headers()['cache-control']).toBe('no-store');
  await page.waitForURL(url=>url.origin===new URL(callback).origin&&url.pathname==='/callback');
  expect(new URL(response.headers().location!).searchParams.get('error')).toBe('access_denied');
  expect((await context.request.get(runtime.url+continuation)).status()).toBe(400);
  expect((await context.request.post(runtime.url+'/oauth/consent',{headers:{origin:runtime.url},form:{ticket,decision:'allow'}})).status()).toBe(400);
  await context.clearCookies();
  await page.goto(authorize);await page.getByRole('link',{name:'Continue to authorization'}).click();
  await expect(page.getByRole('link',{name:'Sign in or recover owner access'})).toHaveAttribute('href','/owner');
  await expect(page.getByRole('button',{name:'Authorize these permissions'})).toHaveCount(0);
 } finally {await context.close();await new Promise<void>(r=>external.close(()=>r()));await runtime.close(info.status!==info.expectedStatus);}
});
