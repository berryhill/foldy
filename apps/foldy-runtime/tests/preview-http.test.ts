import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'foldy-preview-http-')),bundle=join(root,'bundle');
 mkdirSync(bundle);mkdirSync(join(root,'state'),{mode:0o700});
 const html='<!doctype html><h1>Published seed</h1>';
 writeFileSync(join(bundle,'index.html'),html);
 const manifest={schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'book-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]};
 const raw=JSON.stringify(manifest);writeFileSync(join(bundle,'manifest.json'),raw);
 const assertion=randomBytes(32).toString('hex');writeFileSync(join(root,'bootstrap.json'),JSON.stringify({instanceId:'instance-1',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 return {root,assertion,env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(raw),FOLDY_STATE_DIR:join(root,'state'),FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0',FOLDY_EXTERNAL_CACHE_ENABLED:'0'}};
}
async function launch(f:ReturnType<typeof fixture>){
 const child=spawn(process.execPath,[resolve('dist/main.js')],{env:f.env,stdio:['ignore','pipe','pipe']});let logs='';
 child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 for(let i=0;i<100;i++){const m=logs.match(/FOLDY_LISTENING (\d+)/);if(m)return {child,url:`http://127.0.0.1:${m[1]}`};if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,20));}
 child.kill();assert.fail('runtime did not listen');
}
const post=(url:string,body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
test('owner-only preview serves immutable candidate assets without switching the published root',async()=>{
 const f=fixture();let p:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  p=await launch(f);const u=p.url;
  assert.equal((await fetch(u+'/_preview/update/revision/')).status,423);
  const claim=await post(u+'/api/claim',{assertion:f.assertion,password:randomBytes(24).toString('hex')});assert.equal(claim.status,200);
  const owner={cookie:claim.headers.get('set-cookie')!.split(';')[0],origin:u};
  const op=async(name:string,args:Record<string,unknown>)=>{const r=await post(u+'/api/operations',{name,arguments:args},owner);assert.equal(r.status,200,name);return r.json();};
  const base={projectId:'project-1',expectedBaseRevisionId:'revision-1'};
  const created=await op('create_update',{...base,title:'Preview',idempotencyKey:'create'});
  let ref={...base,updateId:created.updateId,expectedUpdateRevisionId:created.updateRevisionId};
  const asset=await op('create_page',{...ref,path:'assets/site.css',content:'body{color:teal}',mediaType:'text/css',idempotencyKey:'asset'});ref.expectedUpdateRevisionId=asset.updateRevisionId;
  const html='<!doctype html><link rel="stylesheet" href="assets/site.css"><h1>Candidate</h1>';
  const edited=await op('update_page',{...ref,path:'index.html',content:html,idempotencyKey:'edit'});ref.expectedUpdateRevisionId=edited.updateRevisionId;
  const prefix=`/_preview/${created.updateId}/${edited.updateRevisionId}/`;
  assert.equal((await fetch(u+prefix)).status,401);
  const grant=await (await post(u+'/api/mcp-grants',{scopes:['foldy:read','foldy:draft:write']},owner)).json();
  assert.equal((await fetch(u+prefix,{headers:{authorization:`Bearer ${grant.token}`}})).status,401);
  const entry=await fetch(u+prefix,{headers:owner});assert.equal(entry.status,200);assert.equal(await entry.text(),html);
  assert.equal(entry.headers.get('cache-control'),'no-store');assert.equal(entry.headers.get('x-content-type-options'),'nosniff');
  assert.match(entry.headers.get('content-security-policy')||'',/default-src 'none'/);
  const css=await fetch(u+prefix+'assets/site.css',{headers:owner});assert.equal(css.status,200);assert.equal(await css.text(),'body{color:teal}');
  const head=await fetch(u+prefix,{method:'HEAD',headers:owner});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),String(Buffer.byteLength(html)));
  assert.match(await (await fetch(u+'/')).text(),/Published seed/);
  const later=await op('update_page',{...ref,path:'index.html',content:'<!doctype html><h1>Later</h1>',idempotencyKey:'later'});ref.expectedUpdateRevisionId=later.updateRevisionId;
  assert.equal(await (await fetch(u+prefix,{headers:owner})).text(),html);
  assert.equal((await fetch(u+`/_preview/${created.updateId}/${later.updateRevisionId}/`,{headers:owner})).status,200);
  for(const path of [`/_preview/${created.updateId}/revision-1/`,`/_preview/${created.updateId}/missing/`,prefix+'missing.css',prefix+'%2e%2e/index.html']){
   const denied=await fetch(u+path,{headers:owner});assert.notEqual(denied.status,200);assert.ok(!(await denied.text()).includes('Candidate'));
  }
  assert.equal((await post(u+prefix,{},owner)).status,405);
  assert.equal((await fetch(u+prefix+'?token=bad',{headers:owner})).status,400);
  const absolute=await op('update_page',{...ref,path:'index.html',content:'<!doctype html><img src="/assets/site.css">',idempotencyKey:'absolute'});
  assert.notEqual((await fetch(u+`/_preview/${created.updateId}/${absolute.updateRevisionId}/`,{headers:owner})).status,200);
  const query=await op('update_page',{...ref,expectedUpdateRevisionId:absolute.updateRevisionId,path:'index.html',content:'<!doctype html><link href="assets/site.css?v=1">',idempotencyKey:'query'});
  const preview=await op('get_update_preview',{projectId:'project-1',updateId:created.updateId});
  assert.equal(preview.value.previewStatus,'blocked');assert.equal(preview.value.ownerPreviewPath,undefined);
  assert.notEqual((await fetch(u+`/_preview/${created.updateId}/${query.updateRevisionId}/`,{headers:owner})).status,200);
  const password=randomBytes(24).toString('hex');
  assert.equal((await post(u+'/api/owner/viewer-access',{mode:'password_required',password},owner)).status,200);
  const unlocked=await post(u+'/api/viewer/unlock',{password},{origin:u});assert.equal(unlocked.status,200);
  const viewer={cookie:unlocked.headers.get('set-cookie')!.split(';')[0]};
  assert.equal((await fetch(u+prefix,{headers:viewer})).status,401);
  assert.equal((await fetch(u+prefix+'assets/site.css',{headers:viewer})).status,401);
  assert.equal((await post(u+'/api/owner/logout',{},owner)).status,200);
  assert.equal((await fetch(u+prefix,{headers:owner})).status,401);
 }finally{if(p){const exit=once(p.child,'exit');p.child.kill();await exit;}rmSync(f.root,{recursive:true,force:true});}
});
