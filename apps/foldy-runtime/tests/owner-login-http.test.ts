import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const opaque=()=>randomBytes(32).toString('hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'foldy-owner-login-')),bundle=join(root,'bundle'),state=join(root,'state');mkdirSync(bundle);mkdirSync(state,{mode:0o700});
 const html='<!doctype html><h1>Owner login fixture</h1>';writeFileSync(join(bundle,'index.html'),html);
 const manifest={schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'book-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]};
 const raw=JSON.stringify(manifest);writeFileSync(join(bundle,'manifest.json'),raw);
 const assertion=opaque(),recoveryFile=join(root,'recovery.json');
 writeFileSync(join(root,'bootstrap.json'),JSON.stringify({instanceId:'instance-1',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 return {root,state,bundleDigest:hash(raw),assertion,recoveryFile,env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(raw),FOLDY_STATE_DIR:state,FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_OWNER_RECOVERY_FILE:recoveryFile,FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0',FOLDY_EXTERNAL_CACHE_ENABLED:'0'}};
}
async function launch(f:ReturnType<typeof fixture>){
 const child=spawn(process.execPath,[resolve('dist/main.js')],{env:f.env,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 for(let i=0;i<100;i++){const m=logs.match(/FOLDY_LISTENING (\d+)/);if(m)return {child,url:`http://127.0.0.1:${m[1]}`,logs:()=>logs};if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,20));}child.kill();assert.fail('runtime startup failed');
}
const post=(url:string,body:unknown,origin:string,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(body)});
test('fresh claim establishes owner password; ordinary login preserves MCP, reset revokes it',async()=>{
 const f=fixture(),password=opaque(),replacement=opaque();let p:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  p=await launch(f);const u=p.url;
  assert.equal((await post(u+'/api/claim',{assertion:f.assertion},u)).status,401);
  assert.equal((await post(u+'/api/claim',{assertion:f.assertion,password:'short'},u)).status,401);
  assert.equal((await fetch(u+'/')).status,423);
  const claim=await post(u+'/api/claim',{assertion:f.assertion,password},u);assert.equal(claim.status,200);
  const old=claim.headers.get('set-cookie')!.split(';')[0];
  assert.equal(readFileSync(join(f.state,'authority.json'),'utf8').includes(password),false);
  assert.equal((await post(u+'/api/claim',{assertion:f.assertion,password},u)).status,409);
  const grantResponse=await post(u+'/api/mcp-grants',{scopes:['foldy:read']},u,{cookie:old});assert.equal(grantResponse.status,201);const grant=await grantResponse.json();
  assert.equal((await post(u+'/api/owner/logout',{},u,{cookie:old})).status,200);
  assert.equal((await post(u+'/api/owner/login',{password:replacement},u)).status,401);
  assert.equal((await post(u+'/api/owner/login',{password},'https://evil.invalid')).status,403);
  const login=await post(u+'/api/owner/login',{password},u);assert.equal(login.status,200);const fresh=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(u+'/api/readiness',{headers:{cookie:fresh}})).status,200);
  assert.equal((await fetch(u+'/api/readiness',{headers:{cookie:old}})).status,401);
  assert.equal((await fetch(u+'/api/mcp-grants',{headers:{cookie:fresh}})).status,200);
  assert.equal((await fetch(u+'/mcp',{headers:{authorization:`Bearer ${grant.token}`}})).status!==401,true);
  const state=JSON.parse(readFileSync(join(f.state,'authority.json'),'utf8'));
  const recovery=opaque();writeFileSync(f.recoveryFile,JSON.stringify({schemaVersion:'foldy-owner-recovery.v1',instanceId:'instance-1',bundleDigest:f.bundleDigest,generation:state.generation,nonce:opaque(),verifier:hash(recovery),expiresAt:Date.now()+600000}),{mode:0o600});
  const reset=await post(u+'/api/owner/recover',{assertion:recovery,password:replacement},u);assert.equal(reset.status,200);
  const resetCookie=reset.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(u+'/api/readiness',{headers:{cookie:fresh}})).status,401);
  assert.equal((await fetch(u+'/mcp',{headers:{authorization:`Bearer ${grant.token}`}})).status,401);
  assert.equal((await post(u+'/api/owner/login',{password},u)).status,401);
  assert.equal((await fetch(u+'/api/readiness',{headers:{cookie:resetCookie}})).status,200);
  assert.equal((await post(u+'/api/owner/recover',{assertion:recovery,password:replacement},u)).status,401);
  assert.ok(!p.logs().includes(password)&&!p.logs().includes(replacement)&&!p.logs().includes(recovery));
 }finally{if(p){const exited=once(p.child,'exit');p.child.kill();await exited;}rmSync(f.root,{recursive:true,force:true});}
});
test('invalid login attempts from a shared source do not lock out the valid owner password',async()=>{
 const f=fixture(),password=opaque(),wrong=opaque();let p:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  p=await launch(f);const u=p.url;
  const claimed=await post(u+'/api/claim',{assertion:f.assertion,password},u);assert.equal(claimed.status,200);
  const cookie=claimed.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post(u+'/api/owner/logout',{},u,{cookie})).status,200);
  for(let i=0;i<20;i++)assert.ok([401,429].includes((await post(u+'/api/owner/login',{password:wrong},u)).status));
  const valid=await post(u+'/api/owner/login',{password},u);
  assert.equal(valid.status,200);
 }finally{if(p){const exited=once(p.child,'exit');p.child.kill();await exited;}rmSync(f.root,{recursive:true,force:true});}
});
