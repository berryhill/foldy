import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { startFoldy } from '../lib/playwright/foldy-runtime.js';

test('a recipient can open and copy exact nonsecret setup links before owner sign-in',async({browser},info)=>{
 const runtime=await startFoldy(),context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
 try{
  await context.grantPermissions(['clipboard-read','clipboard-write']);await page.goto(runtime.url+'/connect');
  await expect(page.getByRole('link',{name:'Open ChatGPT Plugins',exact:true})).toHaveAttribute('href','https://chatgpt.com/plugins');
  await expect(page.getByRole('link',{name:'Open invitation setup',exact:true})).toHaveAttribute('href','/owner/setup');
  await page.getByRole('button',{name:'Copy ChatGPT setup link',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('https://chatgpt.com/plugins');
  await page.getByRole('button',{name:'Copy invitation setup URL',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(runtime.url+'/owner/setup');
  await expect(page.locator('#private')).toBeHidden();
 }finally{await context.close();await runtime.close(info.status!==info.expectedStatus);}
});

test('new owner controls remain disabled until the dashboard has finished loading',async({browser},info)=>{
 const runtime=await startFoldy(),context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
 let release!:()=>void,entered!:()=>void,manifestRequests=0;
 const held=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
 try{
  await page.route('**/mcp/manifest.json',async route=>{
   if(++manifestRequests!==2){await route.continue();return;}
   const response=await route.fetch();entered();await held;await route.fulfill({response});
  });
  await page.goto(runtime.url+'/owner');await page.getByLabel('One-use owner key').fill(runtime.assertion);await page.getByLabel('New owner password').fill(randomBytes(24).toString('hex'));await page.getByRole('button',{name:'Claim ownership',exact:true}).click();
  await waiting;await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('aria-busy','true');
  await expect(page.getByRole('button',{name:'Download backup',exact:true})).toBeDisabled();
  release();await expect(page.locator('main')).not.toHaveAttribute('aria-busy','true');
  await expect(page.getByRole('button',{name:'Download backup',exact:true})).toBeEnabled();
 }finally{release();await context.close();await runtime.close(info.status!==info.expectedStatus);}
});

test('a recipient chooses an owner password through a protected invitation without knowing the old password',async({browser},info)=>{
 const runtime=await startFoldy(),operator=await browser.newContext({ignoreHTTPSErrors:true}),recipient=await browser.newContext({ignoreHTTPSErrors:true}),page=await recipient.newPage();
 const oldPassword=randomBytes(24).toString('hex'),chosenPassword=randomBytes(24).toString('hex');
 const post=async(context:typeof operator,path:string,data:unknown)=>context.request.post(runtime.url+path,{headers:{origin:runtime.url},data});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  expect((await post(operator,'/api/claim',{assertion:runtime.assertion,password:oldPassword})).status()).toBe(200);
  const oldGrant=await(await post(operator,'/api/mcp-grants',{})).json();
  const original=await(await operator.request.get(runtime.url+'/_document/index.html')).body();
  await runtime.stop();
  const recoveryFile=join(runtime.root,'recovery.json'),keyFile=join(runtime.root,'invitation-key.txt');
  const invitation=JSON.parse(execFileSync(process.execPath,[resolve('../apps/foldy-runtime/dist/owner-invitation.js'),'--state-dir',join(runtime.root,'state'),'--bundle-dir',runtime.bundle,'--bundle-digest',runtime.bundleDigest,'--recovery-file',recoveryFile,'--key-file',keyFile,'--setup-origin',runtime.url],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const key=readFileSync(keyFile,'utf8').trim();expect(JSON.stringify(invitation)).not.toContain(key);
  await runtime.restart();await page.goto(invitation.setupUrl);
  await expect(page).toHaveTitle('Owner invitation setup · Foldy');await expect(page.getByRole('heading',{name:'Set up ownership',exact:true})).toBeVisible();
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath('owner-invitation-'+width+'.png'),fullPage:true});
  }
  let submissions=0;page.on('request',r=>{if(r.url()===runtime.url+'/api/owner/recover')submissions++;});
  await page.getByLabel('Protected one-use owner key').fill(key);await page.getByLabel('Choose owner password',{exact:true}).fill(chosenPassword);await page.getByLabel('Confirm owner password',{exact:true}).fill(chosenPassword+'different');
  await page.getByRole('button',{name:'Set up ownership',exact:true}).click();await expect(page.getByRole('status')).toContainText('Passwords do not match');expect(submissions).toBe(0);
  await page.getByLabel('Confirm owner password',{exact:true}).fill(chosenPassword);await page.getByRole('button',{name:'Set up ownership',exact:true}).click();
  await expect(page).toHaveURL(runtime.url+'/owner');await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  expect((await operator.request.get(runtime.url+'/api/readiness')).status()).toBe(401);
  const oldToken=await recipient.request.post(runtime.url+'/mcp',{headers:{authorization:'Bearer '+oldGrant.token,accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'revoked-fixture',version:'1'}}}});expect(oldToken.status()).toBe(401);
  expect((await post(operator,'/api/owner/login',{password:oldPassword})).status()).toBe(401);
  expect((await post(recipient,'/api/owner/recover',{assertion:key,password:chosenPassword})).status()).toBe(401);
  expect(await(await recipient.request.get(runtime.url+'/_document/index.html')).body()).toEqual(original);
  await page.getByRole('button',{name:'Log out of owner workspace'}).click();await expect(page.getByRole('heading',{name:'Sign in as owner'})).toBeVisible();
  await page.getByLabel('Owner password',{exact:true}).fill(chosenPassword);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Review what’s next'})).toBeVisible();
  expect(page.url()).not.toContain(key);expect(page.url()).not.toContain(chosenPassword);
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);expect(errors).toEqual([]);
 }finally{await operator.close();await recipient.close();await runtime.close(info.status!==info.expectedStatus);}
});
