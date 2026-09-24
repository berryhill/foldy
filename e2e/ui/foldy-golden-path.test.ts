import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

// Actual stateful Streamable HTTP JSON-RPC, independent of owner cookies.
async function connect(request: APIRequestContext, url: string, token: string) {
 let id=0;let session='';
 const rpc=async(method:string,params:Record<string,unknown>={},notification=false)=>{
  const response=await request.post(url+'/mcp',{headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26',...(session?{'mcp-session-id':session}:{})},data:{jsonrpc:'2.0',...(!notification?{id:++id}:{}),method,params}});
  expect(response.status()).toBe(notification?202:200);
  if(notification)return;
  session=response.headers()['mcp-session-id']||session;
  const value=await response.json();expect(value.error).toBeUndefined();return value.result;
 };
 const initialized=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'generic-golden-path',version:'1.0'}});
 expect(initialized.protocolVersion).toBe('2025-03-26');expect(Boolean(session)).toBe(true);
 await rpc('notifications/initialized',{},true);
 const tools=(await rpc('tools/list')).tools.map((t:{name:string})=>t.name);
 expect(tools).toContain('get_project');expect(tools).not.toContain('approve_update_revision');expect(tools).not.toContain('publish_update');
 return {tools,call:async(name:string,args:Record<string,unknown>={})=>{
  const result=await rpc('tools/call',{name,arguments:args});expect(result.isError).not.toBe(true);return JSON.parse(result.content[0].text);
 }};
}
async function claim(page:Page,runtime:Awaited<ReturnType<typeof startFoldy>>) {
 await page.goto(runtime.url+'/owner');await page.getByLabel('One-use owner key').fill(runtime.assertion);
 await page.getByRole('button',{name:'Claim ownership',exact:true}).click();
}
async function publish(page:Page,url:string,title:string,before:string,after:string) {
 await page.goto(url+'/owner');
 await page.locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})}).getByRole('button',{name:'Review update'}).click();
 await expect(page.frameLocator('iframe[title="Before: index.html"]').getByRole('heading',{name:before,exact:true})).toBeVisible();
 await expect(page.frameLocator('iframe[title="After: index.html"]').getByRole('heading',{name:after,exact:true})).toBeVisible();
 for(const [label,name,state]of [['Approve this version','approve_update_revision','Approved'],['Publish this version','publish_update','Published']] as const){
  await page.getByLabel('Reason for your decision').fill('Owner reviewed '+after);
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/operations')&&r.request().postDataJSON().name===name);
  await page.getByRole('button',{name:label,exact:true}).click();expect((await pending).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText(state);
 }
}

test('generic MCP proposals survive browser publication, backup and fresh offline restore',async({browser,playwright})=>{
 test.setTimeout(90000);
 const first=await startFoldy();let second:Awaited<ReturnType<typeof startFoldy>>|undefined;
 const owner=await browser.newContext({ignoreHTTPSErrors:true});const restoredOwner=await browser.newContext({ignoreHTTPSErrors:true});
 const viewer=await browser.newContext({ignoreHTTPSErrors:true});const clientRequest=await playwright.request.newContext({ignoreHTTPSErrors:true});
 const page=await owner.newPage(),recovered=await restoredOwner.newPage(),reader=await viewer.newPage();
 page.on('dialog',d=>d.accept());recovered.on('dialog',d=>d.accept());
 const errors:string[]=[];for(const p of [page,recovered,reader])p.on('pageerror',e=>errors.push(e.message));
 const grant=async(request:APIRequestContext,url:string,scopes:string[])=>{
  const response=await request.post(url+'/api/mcp-grants',{headers:{origin:url},data:{scopes}});expect(response.status()).toBe(201);return response.json();
 };
 const propose=async(client:Awaited<ReturnType<typeof connect>>,title:string,heading:string)=>{
  const current=(await client.call('get_project')).observedRevisionId;
  const base={projectId:'project-1',expectedBaseRevisionId:current};
  const created=await client.call('create_update',{...base,title,idempotencyKey:randomUUID()});
  const ref={...base,updateId:created.updateId,expectedUpdateRevisionId:created.updateRevisionId};
  const edited=await client.call('update_page',{...ref,path:'index.html',content:'<!doctype html><h1>'+heading+'</h1>',idempotencyKey:randomUUID()});ref.expectedUpdateRevisionId=edited.updateRevisionId;
  await client.call('submit_update_for_review',{...ref,idempotencyKey:randomUUID()});return ref;
 };
 try{
  await claim(page,first);await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  const readGrant=await grant(owner.request,first.url,['foldy:read']);const readClient=await connect(clientRequest,first.url,readGrant.token);expect(readClient.tools).not.toContain('create_update');
  const draftGrant=await grant(owner.request,first.url,['foldy:read','foldy:draft:write']);const client=await connect(clientRequest,first.url,draftGrant.token);expect(client.tools).toContain('create_update');
  const one=await propose(client,'First MCP proposal','First owner publication');
  await reader.goto(first.url);await expect(reader.getByRole('heading',{name:'Immutable Foldy'})).toBeVisible();
  await publish(page,first.url,'First MCP proposal','Immutable Foldy','First owner publication');
  expect((await client.call('get_project')).observedRevisionId).toBe(one.expectedUpdateRevisionId);
  await reader.reload();await expect(reader.getByRole('heading',{name:'First owner publication'})).toBeVisible();
  await page.getByRole('button',{name:'All updates',exact:true}).click();
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download backup',exact:true}).click();
  const path=await(await downloading).path();expect(path).not.toBeNull();const backup=readFileSync(path!,'utf8');
  expect(backup.includes(draftGrant.token)||backup.includes(readGrant.token)||backup.includes(first.assertion)).toBe(false);
  expect(JSON.parse(backup)).toBeTruthy();
  await first.close();second=await startFoldy(backup);
  expect((await viewer.request.get(second.url)).status()).toBe(423);
  await claim(recovered,second);await expect(recovered.getByRole('heading',{name:'Choose reader access'})).toBeVisible();
  expect((await viewer.request.get(second.url)).status()).toBe(423);
  expect((await(await restoredOwner.request.get(second.url+'/api/mcp-grants')).json()).grants).toEqual([]);
  for(const token of [readGrant.token,draftGrant.token])expect((await clientRequest.post(second.url+'/mcp',{headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'old-client',version:'1'}}}})).status()).toBe(401);
  await recovered.getByRole('button',{name:'Enable public reading',exact:true}).click();await expect(recovered.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  await reader.goto(second.url);await expect(reader.getByRole('heading',{name:'First owner publication'})).toBeVisible();
  const newGrant=await grant(restoredOwner.request,second.url,['foldy:read','foldy:draft:write']);const newClient=await connect(clientRequest,second.url,newGrant.token);
  expect((await newClient.call('get_project')).observedRevisionId).toBe(one.expectedUpdateRevisionId);
  expect((await newClient.call('get_update',{updateId:one.updateId})).value.state).toBe('Published');
  const two=await propose(newClient,'Second MCP proposal','Second owner publication');
  await reader.reload();await expect(reader.getByRole('heading',{name:'First owner publication'})).toBeVisible();
  await publish(recovered,second.url,'Second MCP proposal','First owner publication','Second owner publication');
  expect((await newClient.call('get_project')).observedRevisionId).toBe(two.expectedUpdateRevisionId);
  await reader.reload();await expect(reader.getByRole('heading',{name:'Second owner publication'})).toBeVisible();expect(errors).toEqual([]);
 }finally{await clientRequest.dispose();await owner.close();await restoredOwner.close();await viewer.close();await first.close();await second?.close();}
});
