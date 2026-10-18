import { test, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

test('self-service root, connection, real activity, review and session-loss privacy',async({browser},info)=>{
 const runtime=await startFoldy(undefined,true),context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const post=async(path:string,data:unknown)=>context.request.post(runtime.url+path,{headers:{origin:runtime.url},data});
 const op=async(name:string,args:Record<string,unknown>={})=>{const r=await post('/api/operations',{name,arguments:args});expect(r.status()).toBe(200);return r.json();};
 try{
  await page.goto(runtime.url);await expect(page.getByRole('link',{name:'Connect ChatGPT',exact:true})).toBeVisible();await expect(page.locator('iframe')).toHaveCount(0);
  await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Read Foldy',exact:true})).toBeFocused();await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  await expect(page).toHaveURL(runtime.url+'/connect');await expect(page.getByRole('status')).toContainText('Sign in as owner');
  await expect(page.locator('#transport')).toContainText('Connection unavailable');await expect(page.locator('#private')).toBeHidden();
  for(const width of [1280,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('connect-public-'+width+'.png'),fullPage:true});expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);}
  await page.getByRole('link',{name:'Sign in to authorize and view connection activity'}).click();
  await page.getByLabel('One-use owner key').fill(runtime.assertion);await page.getByLabel('New owner password').fill(randomBytes(24).toString('hex'));await page.getByRole('button',{name:'Claim ownership',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Choose reader access'})).toBeVisible();await page.getByRole('button',{name:'Enable public reading'}).click();await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  await page.goto(runtime.url+'/connect');await expect(page.locator('#private')).toBeVisible();await expect(page.locator('#private')).toContainText('workbook-1');
  await expect(page.getByRole('checkbox',{name:'Optional: show draft proposal instructions'})).not.toBeChecked();await expect(page.getByRole('button',{name:'Copy draft proposal prompt'})).toBeHidden();
  await context.grantPermissions(['clipboard-read','clipboard-write']);await page.getByRole('button',{name:'Copy private MCP endpoint'}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(runtime.url+'/mcp');
  await page.getByRole('button',{name:'Copy read-only test prompt'}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('workbook-1');
  await page.getByRole('checkbox',{name:'Optional: show draft proposal instructions'}).check();await page.getByRole('button',{name:'Copy draft proposal prompt'}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('Do not approve, publish');
  const grant=await(await post('/api/mcp-grants',{scopes:['foldy:read','foldy:draft:write']})).json();
  const headers={authorization:'Bearer '+grant.token,accept:'application/json, text/event-stream'};
  const rpc=async(method:string,params:unknown={},extra:Record<string,string>={})=>context.request.post(runtime.url+'/mcp',{headers:{...headers,...extra},data:{jsonrpc:'2.0',id:1,method,params}});
  const initialized=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'local-browser-test-not-chatgpt',version:'1'}});expect(initialized.status()).toBe(200);
  const session={'mcp-session-id':initialized.headers()['mcp-session-id']!,'mcp-protocol-version':'2025-03-26'};
  await page.getByRole('button',{name:'Retry connection check'}).click();await expect(page.locator('#private')).toContainText('No successful MCP read recorded.');
  const call=async(name:string,args:Record<string,unknown>={})=>{const r=await rpc('tools/call',{name,arguments:args},session);const json=await r.json();expect(json.error).toBeUndefined();return JSON.parse(json.result.content[0].text);};
  await call('get_project');await page.getByRole('button',{name:'Retry connection check'}).click();await expect(page.locator('#private')).toContainText('Successful MCP read:');await expect(page.locator('#transport')).toContainText('Connection unavailable');
  const u=await call('create_update',{projectId:'project-1',expectedBaseRevisionId:'revision-1',title:'Client proposed change',idempotencyKey:randomUUID()});
  const ref={projectId:'project-1',expectedBaseRevisionId:'revision-1',updateId:u.updateId,expectedUpdateRevisionId:u.updateRevisionId};
  await call('submit_update_for_review',{...ref,idempotencyKey:randomUUID()});await page.getByRole('button',{name:'Retry connection check'}).click();await expect(page.locator('#private')).toContainText('Successful draft action:');
  for(const width of [1280,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('connect-owner-'+width+'.png'),fullPage:true});}
  await page.goto(runtime.url+'/owner');await page.getByRole('button',{name:'Review update'}).click();await expect(page.getByRole('heading',{name:'Client proposed change',exact:true})).toBeVisible();
  for(const width of [1280,390]){await page.setViewportSize({width,height:844});await page.screenshot({path:info.outputPath('review-'+width+'.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.getByLabel('Reason for your decision').fill('Reviewed isolated proposal');await page.getByRole('button',{name:'Approve this version',exact:true}).click();await expect(page.getByRole('status')).toContainText('Approved');
  await page.getByLabel('Reason for your decision').fill('Publish reviewed proposal');await page.getByRole('button',{name:'Publish this version',exact:true}).click();await expect(page.getByRole('status')).toContainText('Published');
  await page.goto(runtime.url);await expect(page.frameLocator('iframe[title="Published Foldy"]').getByRole('heading',{name:'Immutable Foldy'})).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox','');
  for(const width of [1280,390]){await page.setViewportSize({width,height:844});await page.screenshot({path:info.outputPath('root-'+width+'.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  const frame=page.frames().find(f=>f.url().includes('/_document/'))!;expect(await frame.evaluate(()=>{try{void parent.document;return false;}catch{return true;}})).toBe(true);
  await page.goto(runtime.url+'/connect');await page.getByRole('button',{name:'Revoke this grant'}).click();await expect(page.getByRole('status')).toHaveText('Grant revoked.');expect((await rpc('tools/call',{name:'get_project',arguments:{}},session)).status()).toBe(401);
  await post('/api/owner/logout',{});await page.getByRole('button',{name:'Retry connection check'}).click();await expect(page.locator('#private')).toBeHidden();expect(await page.locator('#private').textContent()).toBe('');expect(errors).toEqual([]);
 }finally{await context.close();await runtime.close(info.status!==info.expectedStatus);}
});

test('a delayed authenticated refresh cannot restore private data after a newer unauthorized refresh',async({browser},info)=>{
 const runtime=await startFoldy(),context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
 let releaseManifest!:()=>void,manifestEntered!:()=>void,manifestDelivered!:()=>void;
 const held=new Promise<void>(resolve=>{releaseManifest=resolve;}),entered=new Promise<void>(resolve=>{manifestEntered=resolve;}),delivered=new Promise<void>(resolve=>{manifestDelivered=resolve;});
 try{
  await page.goto(runtime.url+'/owner');await page.getByLabel('One-use owner key').fill(runtime.assertion);await page.getByLabel('New owner password').fill(randomBytes(24).toString('hex'));await page.getByRole('button',{name:'Claim ownership',exact:true}).click();await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  await page.route('**/mcp/manifest.json',async route=>{const response=await route.fetch();manifestEntered();await held;await route.fulfill({response});manifestDelivered();});
  await page.goto(runtime.url+'/connect');await entered;
  const logout=await context.request.post(runtime.url+'/api/owner/logout',{headers:{origin:runtime.url},data:{}});expect(logout.status()).toBe(200);
  await page.getByRole('button',{name:'Retry connection check'}).click();await expect(page.getByRole('status')).toContainText('Sign in as owner');
  releaseManifest();await delivered;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.locator('#private')).toBeHidden();expect(await page.locator('#private').textContent()).toBe('');
 }finally{releaseManifest();await context.close();await runtime.close(info.status!==info.expectedStatus);}
});

test('reader document preserves bytes, relative CSS/navigation and opaque authority isolation',async({browser},info)=>{
 const runtime=await startFoldy(undefined,false,true),context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
 try{
  await page.goto(runtime.url+'/owner');await page.getByLabel('One-use owner key').fill(runtime.assertion);await page.getByLabel('New owner password').fill(randomBytes(24).toString('hex'));await page.getByRole('button',{name:'Claim ownership',exact:true}).click();await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  await page.goto(runtime.url);const frame=page.frameLocator('iframe[title="Published Foldy"]');
  await expect(frame.getByRole('heading',{name:'Immutable Foldy'})).toHaveCSS('color','rgb(12, 34, 56)');
  await frame.getByRole('link',{name:'Next page'}).click();await expect(frame.getByRole('heading',{name:'Nested page'})).toHaveCSS('color','rgb(12, 34, 56)');
  await frame.getByRole('link',{name:'Back',exact:true}).click();await expect(frame.getByRole('heading',{name:'Immutable Foldy'})).toBeVisible();
  const document=page.frames().find(f=>f.url().includes('/_document/'))!;
  expect(await document.evaluate(()=>{try{void window.parent.document;return false;}catch{return true;}})).toBe(true);
  expect(await document.evaluate(()=>{try{void window.document.cookie;return false;}catch{return true;}})).toBe(true);
  const original=await(await context.request.get(runtime.url+'/_document/index.html')).text();expect(original).toBe('<!doctype html><link rel="stylesheet" href="theme.css"><h1>Immutable Foldy</h1><a href="nested/page.html">Next page</a>');
  await page.goto(runtime.url+'/owner');await page.getByLabel('New viewing password').fill(randomBytes(24).toString('hex'));page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Require password',exact:true}).click();await expect(page.getByRole('status')).toContainText('Viewing password saved');
  for(const path of ['/_document/index.html','/_document/theme.css','/_document/nested/page.html'])expect((await context.request.get(runtime.url+path)).status()).toBe(401);
 }finally{await context.close();await runtime.close(info.status!==info.expectedStatus);}
});
