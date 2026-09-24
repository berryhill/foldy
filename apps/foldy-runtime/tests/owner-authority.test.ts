import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { OwnerAuthority } from '../dist/owner-authority.js';
const opaque=()=>randomBytes(32).toString('hex');
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'foldy-owner-'));const directory=join(root,'state');mkdirSync(directory,{mode:0o700});
 const bootstrapFile=join(root,'bootstrap.json'),recoveryFile=join(root,'recovery.json'),assertion=opaque();
 const options={directory,instanceId:'instance-1',bundleDigest:hash('bundle'),bootstrapFile,recoveryFile};
 writeFileSync(bootstrapFile,JSON.stringify({instanceId:options.instanceId,verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 const authorization=(a:OwnerAuthority, overrides:Record<string,unknown>={})=>{const secret=opaque();writeFileSync(recoveryFile,JSON.stringify({schemaVersion:'foldy-owner-recovery.v1',instanceId:options.instanceId,bundleDigest:options.bundleDigest,generation:a.state!.generation,nonce:opaque(),verifier:hash(secret),expiresAt:Date.now()+600000,...overrides}),{mode:0o600});return secret;};
 return {root,options,assertion,authorization};
}
function oauthGrants(count: number, expiresAt = Date.now() + 600000) {
 return Array.from({length:count},(_,i)=>({grantId:`oauth:${hash('resource')}:${hash('client')}:${String(i).padStart(36,'0')}`,verifier:hash('test-only'),expiresAt,scopes:['foldy:read','foldy:draft:write']}));
}
for (const nearLimit of [false,true]) test(`oversized authority rejects atomically (${nearLimit?'near byte boundary':'4000 OAuth grants'})`,()=>{
 const f=fixture();try{
 const a=new OwnerAuthority(f.options);const owner=a.claim({assertion:f.assertion});
 const limit=1024*1024;
 if(nearLimit){
  const next={...a.state!,grants:oauthGrants(3000)};
  const remaining=limit-Buffer.byteLength(JSON.stringify(next));
  assert.ok(remaining>0);next.grants[0].grantId+='x'.repeat(remaining);
  a.persist(next);assert.equal(readFileSync(join(f.options.directory,'authority.json')).length,limit);
 }
 const before=a.state!;const bytes=readFileSync(join(f.options.directory,'authority.json'));
 const next=nearLimit?{...before,grants:before.grants.map((g,i)=>i===0?{...g,grantId:g.grantId+'é'}:g)}:{...before,grants:oauthGrants(4000)};
 assert.ok(Buffer.byteLength(JSON.stringify(next))>limit);
 assert.throws(()=>a.persist(next),{message:'AUTHORITY_CAPACITY'});
 assert.deepEqual(a.state,before);assert.deepEqual(readFileSync(join(f.options.directory,'authority.json')),bytes);
 assert.deepEqual(readdirSync(f.options.directory),['authority.json']);
 rmSync(f.options.bootstrapFile);const restarted=new OwnerAuthority(f.options);
 assert.deepEqual(restarted.state,before);assert.equal(restarted.ownerCookie(`__Host-foldy-owner=${owner}`),true);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('persistence prunes expired grants with the existing clock without evicting active grants',()=>{
 const f=fixture();try{
 let now=Date.now();const a=new OwnerAuthority({...f.options,now:()=>now});a.claim({assertion:f.assertion});
 const expired=oauthGrants(3000,now+1),active={...oauthGrants(1,now+600000)[0],grantId:'active'};
 a.persist({...a.state!,grants:[...expired,active]});now++;
 const added={...active,grantId:'new'};
 a.persist({...a.state!,grants:[...a.state!.grants,added]});
 assert.deepEqual(a.state!.grants,[active,added]);
 assert.deepEqual(new OwnerAuthority({...f.options,now:()=>now}).state,a.state);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('expired owner recovers once, clears MCP grants, persists replay denial without bootstrap',()=>{
 const f=fixture();try{
 let now=Date.now();let a=new OwnerAuthority({...f.options,now:()=>now});const old=a.claim({assertion:f.assertion});
 a.persist({...a.state!,grants:[{grantId:'grant',verifier:hash(opaque()),expiresAt:now+100000}]});
 now+=13*3600000;assert.equal(a.ownerCookie(`__Host-foldy-owner=${old}`),false);
 const recovery=f.authorization(a,{expiresAt:now+600000});const fresh=a.recover({assertion:recovery});
 assert.equal(a.ownerCookie(`__Host-foldy-owner=${fresh}`),true);assert.equal(a.ownerCookie(`__Host-foldy-owner=${old}`),false);assert.equal(a.state!.grants.length,0);
 assert.throws(()=>a.recover({assertion:recovery}));assert.throws(()=>a.claim({assertion:f.assertion}));
 rmSync(f.options.bootstrapFile);a=new OwnerAuthority({...f.options,now:()=>now});assert.throws(()=>a.recover({assertion:recovery}));
 a.logout();assert.equal(a.ownerCookie(`__Host-foldy-owner=${fresh}`),false);
 a=new OwnerAuthority({...f.options,now:()=>now});assert.equal(a.ownerCookie(`__Host-foldy-owner=${fresh}`),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
for(const kind of ['identity','bundle','generation','expired','long-expiry','nonce','extra','mode','symlink','ancestry','original-claim'] as const)test(`recovery rejects ${kind} without mutation`,()=>{
 const f=fixture();try{const a=new OwnerAuthority(f.options);a.claim({assertion:f.assertion});
 const overrides:Record<string,unknown>=kind==='identity'?{instanceId:'other'}:kind==='bundle'?{bundleDigest:hash('other')}:kind==='generation'?{generation:0}:kind==='expired'?{expiresAt:Date.now()-1}:kind==='long-expiry'?{expiresAt:Date.now()+1000000}:kind==='nonce'?{nonce:'bad'}:kind==='extra'?{extra:true}:{};
 const secret=f.authorization(a,overrides);const before=readFileSync(join(f.options.directory,'authority.json'),'utf8');
 if(kind==='mode')chmodSync(f.options.recoveryFile,0o644);
 if(kind==='symlink'){const saved=join(f.root,'saved.json');writeFileSync(saved,readFileSync(f.options.recoveryFile),{mode:0o600});rmSync(f.options.recoveryFile);symlinkSync(saved,f.options.recoveryFile);}
 if(kind==='ancestry')chmodSync(f.root,0o777);
 assert.throws(()=>a.recover({assertion:kind==='original-claim'?f.assertion:secret}));assert.equal(readFileSync(join(f.options.directory,'authority.json'),'utf8'),before);
 }finally{chmodSync(f.root,0o700);rmSync(f.root,{recursive:true,force:true});}
});
for(const value of [{ownerVerifier:'bad'},{grants:[{}]},{generation:-1},{ownerExpiresAt:'forever'},{extra:true}])test('malformed persisted authority fails startup',()=>{
 const f=fixture();try{const a=new OwnerAuthority(f.options);a.claim({assertion:f.assertion});writeFileSync(join(f.options.directory,'authority.json'),JSON.stringify({...a.state,...value}));assert.throws(()=>new OwnerAuthority(f.options));}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('HTTP recovery after expiry, CSRF rejection, durable replay and logout',async()=>{
 const f=fixture();let child:ReturnType<typeof spawn>|undefined;let logs='';
 const stop=async()=>{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}};
 try{
 const bundle=join(f.root,'bundle');mkdirSync(bundle);const html='<!doctype html><h1>Recovery proof</h1>';writeFileSync(join(bundle,'index.html'),html);
 const raw=JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'workbook-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]});writeFileSync(join(bundle,'manifest.json'),raw);f.options.bundleDigest=hash(raw);
 const launch=async()=>{logs='';child=spawn(process.execPath,[resolve('dist/main.js')],{env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(raw),FOLDY_STATE_DIR:f.options.directory,FOLDY_BOOTSTRAP_FILE:f.options.bootstrapFile,FOLDY_OWNER_RECOVERY_FILE:f.options.recoveryFile,FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0'},stdio:['ignore','pipe','pipe']});child.stdout!.on('data',c=>logs+=c);child.stderr!.on('data',c=>logs+=c);for(let i=0;i<100;i++){const m=logs.match(/FOLDY_LISTENING (\d+)/);if(m)return `http://127.0.0.1:${m[1]}`;if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,20));}throw Error('TEST_START_FAILED');};
 let url=await launch();const post=(path:string,input:unknown,headers:Record<string,string>={})=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',origin:url,...headers},body:JSON.stringify(input)});
 const claim=await post('/api/claim',{assertion:f.assertion});assert.equal(claim.status,200);const old=claim.headers.get('set-cookie')!.split(';')[0];
 const grant=await(await post('/api/mcp-grants',{}, {cookie:old})).json();
 await stop();const statePath=join(f.options.directory,'authority.json');const state=JSON.parse(readFileSync(statePath,'utf8'));state.ownerExpiresAt=Date.now()-1;writeFileSync(statePath,JSON.stringify(state));
 const a=new OwnerAuthority(f.options);const recovery=f.authorization(a);rmSync(f.options.bootstrapFile);url=await launch();
 assert.equal((await fetch(url+'/api/readiness',{headers:{cookie:old}})).status,401);
 assert.equal((await post('/api/owner/recover',{assertion:recovery},{origin:'https://other.invalid'})).status,403);
 assert.equal((await post('/api/owner/recover',{assertion:recovery},{origin:''})).status,403);
 const recovered=await post('/api/owner/recover',{assertion:recovery});assert.equal(recovered.status,200);const cookie=recovered.headers.get('set-cookie')!.split(';')[0];
 assert.equal((await fetch(url+'/api/readiness',{headers:{cookie}})).status,200);
 assert.equal((await fetch(url+'/mcp',{headers:{authorization:`Bearer ${grant.token}`}})).status,401);
 assert.equal((await post('/api/owner/recover',{assertion:recovery})).status,401);
 assert.equal((await post('/api/claim',{assertion:f.assertion})).status,409);
 assert.equal((await post('/api/owner/logout',{}, {cookie,origin:'https://other.invalid'})).status,403);
 assert.equal((await post('/api/owner/logout',{}, {cookie})).status,200);
 await stop();url=await launch();assert.equal((await fetch(url+'/api/readiness',{headers:{cookie}})).status,401);assert.equal((await post('/api/owner/recover',{assertion:recovery})).status,401);
 assert.ok(!logs.includes(recovery)&&!logs.includes(f.assertion)&&!logs.includes(grant.token));
 }finally{await stop();rmSync(f.root,{recursive:true,force:true});}
});
