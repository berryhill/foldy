import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, chmodSync, symlinkSync, linkSync } from 'node:fs';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { OwnerAuthority } from '../dist/owner-authority.js';
import { createOwnerPairing, approveOwnerPairing } from '../dist/owner-pairing.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const opaque=()=>randomBytes(32).toString('hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'foldy-pairing-test-')),state=join(root,'state'),bundle=join(root,'bundle');mkdirSync(state,{mode:0o700});mkdirSync(bundle,{mode:0o700});
 const html='<h1>Existing content</h1>',raw=JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'book-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]});
 writeFileSync(join(bundle,'index.html'),html);writeFileSync(join(bundle,'manifest.json'),raw);
 const bundleDigest=hash(raw),bootstrapFile=join(root,'bootstrap.json'),recoveryFile=join(root,'recovery.json'),assertion=opaque();
 writeFileSync(bootstrapFile,JSON.stringify({instanceId:'instance-1',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 const options={directory:state,instanceId:'instance-1',bundleDigest,bootstrapFile,recoveryFile};
 const approval={stateDirectory:state,bundleDirectory:bundle,bundleDigest,recoveryFile};
 return {root,state,bundle,bootstrapFile,recoveryFile,assertion,options,approval};
}
test('request approval binds private browser secret to recovery and consumes generation',async()=>{
 const f=fixture();try{
  const a=new OwnerAuthority(f.options),oldPassword=opaque(),newPassword=opaque();const old=await a.claimWithPassword({assertion:f.assertion,password:oldPassword});
  a.persist({...a.state!,grants:[{grantId:'g',verifier:hash(opaque()),expiresAt:Date.now()+600000}]});
  const {requestId,browserSecret,expiresAt}=createOwnerPairing({stateDirectory:f.state,instanceId:'instance-1',bundleDigest:f.options.bundleDigest});
  assert.match(requestId,/^[a-f0-9]{64}$/);assert.equal(browserSecret.length,43);assert.ok(expiresAt<=Date.now()+900000);
  const row=readFileSync(join(f.state,'owner-pairings',requestId+'.json'),'utf8');assert.ok(!row.includes(browserSecret));
  await assert.rejects(a.recoverWithPassword({assertion:requestId,password:newPassword}));
  await assert.rejects(a.recoverWithPassword({assertion:browserSecret,password:newPassword}));
  assert.throws(()=>approveOwnerPairing({...f.approval,requestId:opaque()}));
  assert.throws(()=>approveOwnerPairing({...f.approval,requestId:requestId.slice(0,-1)}));
  assert.throws(()=>approveOwnerPairing({...f.approval,requestId:requestId.toUpperCase()}));
  assert.equal(approveOwnerPairing({...f.approval,requestId}).requestId,requestId);
  assert.equal(JSON.parse(readFileSync(f.recoveryFile,'utf8')).verifier,hash(browserSecret));
  await assert.rejects(a.recoverWithPassword({assertion:requestId,password:newPassword}));
  await assert.rejects(a.recoverWithPassword({assertion:opaque(),password:newPassword}));
  const reopened=new OwnerAuthority(f.options);
  const competing=await Promise.allSettled([reopened.recoverWithPassword({assertion:browserSecret,password:newPassword}),reopened.recoverWithPassword({assertion:browserSecret,password:newPassword})]);
  assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);assert.equal(competing.filter(r=>r.status==='rejected').length,1);
  const next=(competing.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
  assert.equal(reopened.ownerCookie(`__Host-foldy-owner=${old}`),false);assert.equal(reopened.ownerCookie(`__Host-foldy-owner=${next}`),true);assert.deepEqual(reopened.state!.grants,[]);
  await assert.rejects(new OwnerAuthority(f.options).recoverWithPassword({assertion:browserSecret,password:newPassword}));
  await assert.rejects(reopened.login({password:oldPassword}));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('approval rejects lock, preexisting authorization, generation change and unsafe rows',async()=>{
 const f=fixture();try{
  const a=new OwnerAuthority(f.options),password=opaque();await a.claimWithPassword({assertion:f.assertion,password});
  const p=createOwnerPairing({stateDirectory:f.state,instanceId:'instance-1',bundleDigest:f.options.bundleDigest});
  writeFileSync(join(f.state,'runtime.lock'),'busy',{mode:0o600});assert.throws(()=>approveOwnerPairing({...f.approval,requestId:p.requestId}));rmSync(join(f.state,'runtime.lock'));
  await a.login({password});assert.throws(()=>approveOwnerPairing({...f.approval,requestId:p.requestId}));
  const q=createOwnerPairing({stateDirectory:f.state,instanceId:'instance-1',bundleDigest:f.options.bundleDigest});
  writeFileSync(f.recoveryFile,'existing',{mode:0o600});assert.throws(()=>approveOwnerPairing({...f.approval,requestId:q.requestId}));assert.equal(readFileSync(f.recoveryFile,'utf8'),'existing');rmSync(f.recoveryFile);
  const row=join(f.state,'owner-pairings',q.requestId+'.json'),other=join(f.root,'other');writeFileSync(other,'outside',{mode:0o600});rmSync(row);symlinkSync(other,row);assert.throws(()=>approveOwnerPairing({...f.approval,requestId:q.requestId}));rmSync(row);linkSync(other,row);assert.throws(()=>approveOwnerPairing({...f.approval,requestId:q.requestId}));rmSync(row);
  chmodSync(f.state,0o777);assert.throws(()=>createOwnerPairing({stateDirectory:f.state,instanceId:'instance-1',bundleDigest:f.options.bundleDigest}));
 }finally{chmodSync(f.state,0o700);rmSync(f.root,{recursive:true,force:true});}
});
test('pairing expiration, bounded capacity and browser substitution',async()=>{
 const f=fixture();try{
  const a=new OwnerAuthority(f.options);await a.claimWithPassword({assertion:f.assertion,password:opaque()});
  let now=Date.now();const input={stateDirectory:f.state,instanceId:'instance-1',bundleDigest:f.options.bundleDigest,now:()=>now};
  const first=createOwnerPairing(input);const second=createOwnerPairing(input);
  assert.notEqual(first.requestId,second.requestId);assert.notEqual(first.browserSecret,second.browserSecret);
  now+=900000;assert.throws(()=>approveOwnerPairing({...f.approval,requestId:first.requestId,now:()=>now}));
  const fresh=createOwnerPairing({...input,now:()=>now});approveOwnerPairing({...f.approval,requestId:fresh.requestId,now:()=>now});
  await assert.rejects(a.recoverWithPassword({assertion:second.browserSecret,password:opaque()}));
  assert.ok(readdirSync(join(f.state,'owner-pairings')).length<=32);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('capacity counts active requests only and unknown entries fail closed',async()=>{
 const f=fixture();try{
  const a=new OwnerAuthority(f.options),password=opaque();await a.claimWithPassword({assertion:f.assertion,password});
  let now=Date.now();const input={stateDirectory:f.state,instanceId:'instance-1',bundleDigest:f.options.bundleDigest,now:()=>now};
  for(let i=0;i<32;i++)createOwnerPairing(input);
  assert.throws(()=>createOwnerPairing(input));
  now+=900000;createOwnerPairing(input);
  assert.equal(readdirSync(join(f.state,'owner-pairings')).length,1);
  await a.login({password});createOwnerPairing(input);
  assert.equal(readdirSync(join(f.state,'owner-pairings')).length,1);
  writeFileSync(join(f.state,'owner-pairings','unknown'),'leave intact',{mode:0o600});
  assert.throws(()=>createOwnerPairing(input));
  assert.equal(readFileSync(join(f.state,'owner-pairings','unknown'),'utf8'),'leave intact');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
