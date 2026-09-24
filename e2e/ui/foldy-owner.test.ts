import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

test('stale competing proposals refresh safely, request review and close with history', async ({browser},info)=>{
 const runtime=await startFoldy();const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const op=async(name:string,args:Record<string,unknown>={})=>{const r=await context.request.post(runtime.url+'/api/operations',{headers:{origin:runtime.url},data:{name,arguments:args}});expect(r.status()).toBe(200);return r.json();};
 try{
  await page.goto(runtime.url+'/owner');await page.getByLabel('One-use owner key').fill(runtime.assertion);await page.getByRole('button',{name:'Claim ownership',exact:true}).click();await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  const create=async(title:string)=>{const r=await op('create_update',{projectId:'project-1',expectedBaseRevisionId:'revision-1',title,idempotencyKey:randomUUID()});return {projectId:'project-1',expectedBaseRevisionId:'revision-1',updateId:r.updateId,expectedUpdateRevisionId:r.updateRevisionId};};
  const a=await create('Published competitor'),b=await create('Refreshable proposal'),c=await create('Conflicting proposal');
  const edit=async(ref:typeof a,name:string,extra:Record<string,unknown>)=>{const r=await op(name,{...ref,...extra,idempotencyKey:randomUUID()});ref.expectedUpdateRevisionId=r.updateRevisionId;return r;};
  await edit(b,'create_page',{path:'notes.html',mediaType:'text/html',content:'<h1>Retained proposal</h1>'});
  await edit(c,'update_page',{path:'index.html',content:'<h1>Conflicting change</h1>'});
  await edit(a,'update_page',{path:'index.html',content:'<h1>New publication</h1>'});
  await edit(a,'submit_update_for_review',{});await edit(a,'approve_update_revision',{reason:'Reviewed'});await edit(a,'publish_update',{reason:'Publish competitor'});
  const open=async(title:string)=>{await page.goto(runtime.url+'/owner');await page.locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})}).getByRole('button',{name:'Review update'}).click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();};
  await open('Conflicting proposal');await page.getByLabel('Comment',{exact:true}).fill('Unsaved feedback remains');await page.getByLabel('Reason for your decision').fill('Unsaved decision');
  const original=(await op('get_update',{updateId:c.updateId})).value;
  await page.getByRole('button',{name:'Refresh proposal',exact:true}).click();await expect(page.getByRole('alert')).toContainText('index.html');await expect(page.getByRole('status')).toContainText('Nothing was changed');
  await expect(page.getByLabel('Comment',{exact:true})).toHaveValue('Unsaved feedback remains');await expect(page.getByLabel('Reason for your decision')).toHaveValue('Unsaved decision');expect((await op('get_update',{updateId:c.updateId})).value).toEqual(original);
  await page.getByLabel('Reason for your decision').fill('Conflicting proposal abandoned');await page.getByRole('button',{name:'Close update',exact:true}).click();await expect(page.getByRole('status')).toContainText('Closed');
  await open('Conflicting proposal');await page.getByText('Decision history',{exact:true}).click();await expect(page.getByText('Conflicting proposal abandoned',{exact:true})).toBeVisible();expect((await op('get_project')).observedRevisionId).toBe(a.expectedUpdateRevisionId);
  await open('Refreshable proposal');
  const request=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/operations')&&r.postDataJSON().name==='refresh_update_proposal');
  await page.getByRole('button',{name:'Refresh proposal',exact:true}).click();const payload=(await request).postDataJSON().arguments;
  expect(payload.expectedBaseRevisionId).toBe('revision-1');expect(payload.newPublishedBaseRevisionId).toBe(a.expectedUpdateRevisionId);
  await expect(page.getByRole('status')).toContainText('Draft');const refreshed=(await op('get_update',{updateId:b.updateId})).value;expect(refreshed.base).toBe(a.expectedUpdateRevisionId);
  await page.getByText('Readiness evidence',{exact:true}).click();await expect(page.getByText(/Dependencies: Pass/)).toBeVisible();
  await page.getByText('Revision history',{exact:true}).click();await expect(page.getByText(refreshed.revision+' · Parent: '+b.expectedUpdateRevisionId,{exact:false})).toBeVisible();
  await page.getByLabel('Comment',{exact:true}).fill('Specific feedback');await page.getByLabel('Page path (optional)').fill('notes.html');await page.getByLabel('Block (optional)').fill('intro');await page.getByLabel('Field (optional)').fill('title');await page.getByLabel('Selection (optional)').fill('Retained proposal');
  await page.getByRole('button',{name:'Add comment',exact:true}).click();await expect(page.getByText('Specific feedback',{exact:true})).toBeVisible();
  const commented=(await op('get_update',{updateId:b.updateId})).value;expect(commented.comments[0].target).toEqual({path:'notes.html',block:'intro',field:'title',selection:'Retained proposal'});
  await page.getByRole('button',{name:'Request review',exact:true}).click();await expect(page.getByRole('status')).toContainText('Ready for review');
  await page.getByLabel('Reason for your decision').fill('Superseded after review');await page.getByRole('button',{name:'Close update',exact:true}).click();await expect(page.getByRole('status')).toContainText('Closed');await expect(page.getByRole('status')).toContainText('Superseded after review');
  const closed=(await op('get_update',{updateId:b.updateId})).value;expect(closed.state).toBe('Closed');expect(closed.comments).toEqual(commented.comments);expect(closed.revision).toBe(refreshed.revision);
  const backup=await (await context.request.get(runtime.url+'/api/backup')).text();expect(backup).toContain('Superseded after review');
  await open('Refreshable proposal');await expect(page.getByText('Specific feedback',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Request review',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Close update',exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);
 }finally{await context.close();await runtime.close(info.status!==info.expectedStatus);}
});

test('standalone owner keyboard claim, review, publication and reader separation', async ({ browser }, info) => {
 const runtime = await startFoldy();
 const owner = await browser.newContext({ignoreHTTPSErrors:true}); const viewer = await browser.newContext({ignoreHTTPSErrors:true});
 const page = await owner.newPage(); const reader = await viewer.newPage();
 const errors: string[] = []; const consoleErrors: string[] = [];
 for(const p of [page,reader]) {p.on('pageerror', e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});}
 const snapshot = async(p:Page,name:string) => {
  expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await p.screenshot({path:info.outputPath(name+'.png'),fullPage:true});
 };
 const post = async(name:string,args:Record<string,unknown>)=>{
  const response=await owner.request.post(runtime.url+'/api/operations',{headers:{origin:runtime.url},data:{name,arguments:args}});
  expect(response.status()).toBe(200); return response.json();
 };
 const clickMutation = async(label:string,name:string)=>{
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/operations'&&r.request().postDataJSON().name===name);
  await page.getByRole('button',{name:label,exact:true}).click(); expect((await response).status()).toBe(200);
 };
 try {
  await page.goto(runtime.url+'/owner'); await expect(page.getByRole('heading',{name:'Claim your Foldy'})).toBeVisible();
  // No traces/videos: generated one-use assertion never enters retained artifacts.
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await expect(page.getByLabel('One-use owner key')).toBeFocused();
  expect(await page.getByLabel('One-use owner key').evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');
  await snapshot(page,'claim-desktop');
  await page.keyboard.insertText(runtime.assertion);
  const claimed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/claim'&&r.request().method()==='POST');
  await page.keyboard.press('Enter'); expect((await claimed).status()).toBe(200);
  await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Connect assistants',exact:true})).toBeVisible();
  const manifest=await (await owner.request.get(runtime.url+'/mcp/manifest.json')).json();
  const discoveryURL=new URL(manifest.authenticationDiscovery.protectedResourceMetadata,runtime.url).href;
  await expect(page.getByRole('link',{name:'OAuth discovery (preferred)'})).toHaveAttribute('href',discoveryURL);
  expect((await owner.request.get(discoveryURL)).status()).toBe(200);
  await expect(page.getByLabel('Explicitly allow draft proposals (never approval or publication)')).not.toBeChecked();
  const grantResponse=await owner.request.post(runtime.url+'/api/mcp-grants',{headers:{origin:runtime.url},data:{scopes:['foldy:read']}});
  expect(grantResponse.status()).toBe(201);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByRole('button',{name:'Revoke this grant',exact:true})).toBeVisible();
  page.once('dialog',d=>d.accept());
  const revoked=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/mcp-grants/revoke'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Revoke this grant',exact:true}).click();
  expect((await revoked).status()).toBe(200);
  await expect(page.getByText('No assistant grants.',{exact:true})).toBeVisible();
  const base={projectId:'project-1',expectedBaseRevisionId:'revision-1'};
  const created=await post('create_update',{...base,title:'Reader welcome update',idempotencyKey:randomUUID()});
  const ref={...base,updateId:created.updateId,expectedUpdateRevisionId:created.updateRevisionId};
  const content='<!doctype html><h1>Published welcome</h1><p>Reviewed by the owner.</p>';
  const edit=await post('update_page',{...ref,path:'index.html',content,idempotencyKey:randomUUID()}); ref.expectedUpdateRevisionId=edit.updateRevisionId;
  await post('submit_update_for_review',{...ref,idempotencyKey:randomUUID()});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('button',{name:'Review update'}).click();
  await expect(page.locator('pre').nth(0)).toContainText('Immutable Foldy');
  await expect(page.locator('pre').nth(1)).toHaveText(content);
  await expect(page.frameLocator('iframe[title="Before: index.html"]').getByRole('heading',{name:'Immutable Foldy'})).toBeVisible();
  await expect(page.frameLocator('iframe[title="After: index.html"]').getByRole('heading',{name:'Published welcome'})).toBeVisible();
  await snapshot(page,'review-desktop');
  await page.setViewportSize({width:390,height:844}); await snapshot(page,'review-mobile');
  page.on('dialog', d=>d.accept());
  await page.getByLabel('Reason for your decision').fill('Reviewed readable before and after content');
  await clickMutation('Approve this version','approve_update_revision');
  await expect(page.getByRole('status')).toContainText('Approved');
  await page.getByLabel('Reason for your decision').fill('Publish the reviewed version');
  await clickMutation('Publish this version','publish_update');
  await expect(page.getByRole('status')).toContainText('Published');
  expect((await post('get_update',{updateId:created.updateId})).value.state).toBe('Published');
  await reader.goto(runtime.url); await expect(reader.getByRole('heading',{name:'Published welcome'})).toBeVisible();
  await page.getByRole('button',{name:'All updates'}).click();
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download backup',exact:true}).click();
  const download=await downloadEvent;
  const backupPath=await download.path();expect(backupPath).not.toBeNull();
  expect(JSON.parse(readFileSync(backupPath!,'utf8'))).toBeTruthy();
  await expect(page.getByRole('heading',{name:'Instance status',exact:true})).toBeVisible();await expect(page.getByText(/Last backup prepared:/)).toBeVisible();
  const diagnosticsEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download diagnostics',exact:true}).click();const diagnosticsPath=await(await diagnosticsEvent).path();const diagnostics=JSON.parse(readFileSync(diagnosticsPath!,'utf8'));expect(diagnostics.schemaVersion).toBe('foldy-owner-status.v1');expect(diagnostics.operations.lastBackup.revisionId).toBeTruthy();expect(JSON.stringify(diagnostics)).not.toContain(runtime.assertion);
  const password=randomBytes(24).toString('hex');
  await page.getByLabel('New viewing password').fill(password);
  const configured=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/owner/viewer-access'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Require password',exact:true}).click();expect((await configured).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('Viewing password saved');await snapshot(page,'owner-mobile');
  expect((await viewer.request.get(runtime.url)).status()).toBe(401);
  await reader.setViewportSize({width:390,height:844}); await reader.goto(runtime.url+'/unlock');
  await expect(reader.getByLabel('Viewing password',{exact:true})).toBeVisible();
  await reader.keyboard.press('Tab');await reader.keyboard.press('Tab');await expect(reader.getByLabel('Viewing password',{exact:true})).toBeFocused();
  await snapshot(reader,'unlock-mobile');
  await reader.keyboard.insertText(password);
  const unlocked=reader.waitForResponse(r=>new URL(r.url()).pathname==='/api/viewer/unlock'&&r.request().method()==='POST');
  await reader.keyboard.press('Enter');expect((await unlocked).status()).toBe(200);
  await expect(reader.getByRole('heading',{name:'Published welcome'})).toBeVisible();
  expect((await viewer.request.post(runtime.url+'/api/operations',{headers:{origin:runtime.url},data:{name:'list_updates',arguments:{}}})).status()).toBe(401);
  await reader.goto(runtime.url+'/owner');await expect(reader.getByRole('heading',{name:'Claim your Foldy'})).toBeVisible();
  await reader.goto(runtime.url+'/unlock');
  const loggedOut=reader.waitForResponse(r=>new URL(r.url()).pathname==='/api/viewer/logout'&&r.request().method()==='POST');
  await reader.getByRole('button',{name:'Log out of viewing',exact:true}).click();
  expect((await loggedOut).status()).toBe(200);
  expect((await viewer.request.get(runtime.url)).status()).toBe(401);
  const ownerLoggedOut=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/owner/logout'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Log out of owner workspace',exact:true}).click();
  expect((await ownerLoggedOut).status()).toBe(200);
  await expect(page.getByRole('heading',{name:'Claim your Foldy'})).toBeVisible();
  expect(errors).toEqual([]);
 } finally {
  writeFileSync(info.outputPath('browser-diagnostics.json'),JSON.stringify({pageErrors:errors,consoleErrors},null,2));
  await info.attach('browser-diagnostics',{body:JSON.stringify({pageErrors:errors,consoleErrors}),contentType:'application/json'});
  await reader.close();await page.close();await viewer.close();await owner.close();
  const preserve=info.status!==info.expectedStatus;
  if(preserve) await info.attach('runtime-scratch',{body:runtime.root,contentType:'text/plain'});
  await runtime.close(preserve);
 }
});

test('authored preview is inert, isolated and uses revision-local styles', async ({browser},info)=>{
 const runtime=await startFoldy();const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
 const unexpected:string[]=[];
 try{
  await page.goto(runtime.url+'/owner');await page.getByLabel('One-use owner key').fill(runtime.assertion);await page.getByRole('button',{name:'Claim ownership',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  const op=async(name:string,args:Record<string,unknown>)=>{const r=await context.request.post(runtime.url+'/api/operations',{headers:{origin:runtime.url},data:{name,arguments:args}});expect(r.status()).toBe(200);return r.json();};
  const base={projectId:'project-1',expectedBaseRevisionId:'revision-1'};
  const u=await op('create_update',{...base,title:'Hostile author preview',idempotencyKey:randomUUID()});
  const ref={...base,updateId:u.updateId,expectedUpdateRevisionId:u.updateRevisionId};
  const css=await op('create_page',{...ref,path:'theme.css',mediaType:'text/css',content:'h1{color:rgb(12, 34, 56)}',idempotencyKey:randomUUID()});ref.expectedUpdateRevisionId=css.updateRevisionId;
  await op('update_page',{...ref,path:'index.html',content:`<!doctype html><link rel="stylesheet" href="theme.css"><h1>Safe readable proposal</h1><script>parent.document.querySelector('h1').textContent='COMPROMISED';fetch('/api/owner/logout',{method:'POST'});</script><img src="https://evil.invalid/leak" onerror="parent.document.body.textContent='COMPROMISED'"><iframe src="/owner"></iframe><meta http-equiv="refresh" content="0;url=https://evil.invalid/refresh"><form action="/api/owner/logout" method="post"><button>Attack submit</button></form><a href="https://evil.invalid/top" target="_top">Attack link</a><a href="javascript:alert(1)">Script link</a><style>body{background-image:url(https://evil.invalid/css)}</style>`,idempotencyKey:randomUUID()});
  page.on('request',r=>{
   const trustedOwnerRequest=r.frame()===page.mainFrame()&&(r.url().startsWith(runtime.url+'/api/')||r.url()===runtime.url+'/mcp/manifest.json');
   if(!trustedOwnerRequest&&!r.url().startsWith('data:'))unexpected.push(r.url());
  });
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Review update'}).click();
  const frame=page.frameLocator('iframe[title="After: index.html"]');
  await expect(frame.getByRole('heading',{name:'Safe readable proposal'})).toBeVisible();
  await expect(frame.getByRole('heading')).toHaveCSS('color','rgb(12, 34, 56)');
  await expect(page.locator('iframe[title="After: index.html"]')).toHaveAttribute('sandbox','');
  await expect(frame.getByRole('button',{name:'Attack submit'})).toBeDisabled();
  await expect(frame.locator('a').first()).not.toHaveAttribute('href');await frame.getByText('Attack link').click();
  await expect(frame.locator('script,iframe,meta[http-equiv="refresh"]')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Hostile author preview'})).toBeVisible();
  expect(page.url()).toBe(runtime.url+'/owner');expect(context.pages()).toHaveLength(1);
  const child=page.frames().find(f=>f.url()==='about:srcdoc'&&f!==page.mainFrame());expect(child).toBeTruthy();
  expect(await child!.evaluate(()=>{try{void parent.document;return false;}catch{return true;}})).toBe(true);
  expect(await child!.evaluate(()=>{try{void document.cookie;return false;}catch{return true;}})).toBe(true);
  await child!.evaluate(()=>{const s=document.createElement('script');s.textContent="document.body.textContent='DYNAMIC EXECUTED';fetch('https://evil.invalid/dynamic')";document.body.append(s);});
  await expect(page.frameLocator('iframe[title="Before: index.html"]').getByRole('heading',{name:'Immutable Foldy'})).toBeVisible();
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('safe-preview-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('safe-preview-390.png'),fullPage:true});
  await page.getByText('Show source',{exact:true}).nth(1).click();await expect(page.locator('pre').nth(1)).toBeVisible();
 }finally{await context.close();await runtime.close(info.status!==info.expectedStatus);}
});
