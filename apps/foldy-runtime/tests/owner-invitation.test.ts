import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { OwnerAuthority } from '../dist/owner-authority.js';
import { issueOwnerInvitation } from '../dist/owner-invitation.js';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const opaque=()=>randomBytes(32).toString('hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'foldy-invitation-')),state=join(root,'state'),bundle=join(root,'bundle');mkdirSync(state,{mode:0o700});mkdirSync(bundle,{mode:0o700});
 const html='<!doctype html><h1>Existing content</h1>',raw=JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'book-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]});
 writeFileSync(join(bundle,'index.html'),html);writeFileSync(join(bundle,'manifest.json'),raw);
 const bundleDigest=hash(raw),bootstrap=join(root,'bootstrap.json'),recoveryFile=join(root,'recovery.json'),keyFile=join(root,'key.txt'),assertion=opaque();
 writeFileSync(bootstrap,JSON.stringify({instanceId:'instance-1',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 const options={directory:state,instanceId:'instance-1',bundleDigest,bootstrapFile:bootstrap,recoveryFile};
 const input={stateDirectory:state,bundleDirectory:bundle,bundleDigest,recoveryFile,keyFile,setupOrigin:'https://foldy.example'};
 return {root,state,bundle,recoveryFile,keyFile,assertion,options,input};
}
test('claimed instance issues one-use invitation; chosen password replaces old authority, survives restart',async()=>{
 const f=fixture();try{
  const a=new OwnerAuthority(f.options),oldPassword=opaque(),newPassword=opaque();const old=a.claimWithPassword({assertion:f.assertion,password:oldPassword});const cookie=`__Host-foldy-owner=${await old}`;
  const grant={grantId:'grant',verifier:hash(opaque()),expiresAt:Date.now()+600000,scopes:['foldy:read']};a.persist({...a.state!,grants:[grant]});
  const content=readFileSync(join(f.bundle,'index.html')),beforeGeneration=a.state!.generation;
  const result=issueOwnerInvitation(f.input);assert.equal(result.setupUrl,'https://foldy.example/owner/setup');assert.equal(result.recoveryFile,f.recoveryFile);assert.equal(result.keyFile,f.keyFile);
  const key=readFileSync(f.keyFile,'utf8').trim();assert.ok(!JSON.stringify(result).includes(key));
  const authorization=JSON.parse(readFileSync(f.recoveryFile,'utf8'));assert.equal(authorization.generation,beforeGeneration);assert.equal(authorization.verifier,hash(key));
  await assert.rejects(a.recoverWithPassword({assertion:key,password:'short'}));assert.equal(a.state!.generation,beforeGeneration);
  const pending=a.recoverWithPassword({assertion:key,password:newPassword});await assert.rejects(a.recoverWithPassword({assertion:key,password:newPassword}));
  const next=await pending;assert.equal(a.ownerCookie(cookie),false);assert.equal(a.ownerCookie(`__Host-foldy-owner=${next}`),true);assert.deepEqual(a.state!.grants,[]);
  assert.deepEqual(readFileSync(join(f.bundle,'index.html')),content);
  await assert.rejects(a.login({password:oldPassword}));await assert.rejects(a.recoverWithPassword({assertion:key,password:newPassword}));a.logout();
  const reopened=new OwnerAuthority(f.options);await assert.rejects(reopened.recoverWithPassword({assertion:key,password:newPassword}));const session=await reopened.login({password:newPassword});assert.equal(reopened.ownerCookie(`__Host-foldy-owner=${session}`),true);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('issuer rejects mismatched bundle, unclaimed state, existing outputs and unsafe output custody',async()=>{
 const f=fixture();try{
  assert.throws(()=>issueOwnerInvitation(f.input));assert.equal(existsSync(f.keyFile),false);
  const a=new OwnerAuthority(f.options);await a.claimWithPassword({assertion:f.assertion,password:opaque()});
  assert.throws(()=>issueOwnerInvitation({...f.input,bundleDigest:hash('wrong')}));
  writeFileSync(f.keyFile,'existing',{mode:0o600});assert.throws(()=>issueOwnerInvitation(f.input));assert.equal(readFileSync(f.keyFile,'utf8'),'existing');rmSync(f.keyFile);
  const target=join(f.root,'target');writeFileSync(target,'existing',{mode:0o600});symlinkSync(target,f.keyFile);assert.throws(()=>issueOwnerInvitation(f.input));rmSync(f.keyFile);
  linkSync(target,f.keyFile);assert.throws(()=>issueOwnerInvitation(f.input));rmSync(f.keyFile);
  chmodSync(f.root,0o777);assert.throws(()=>issueOwnerInvitation(f.input));chmodSync(f.root,0o700);
  assert.throws(()=>issueOwnerInvitation({...f.input,setupOrigin:'https://foldy.example/?key=bad'}));
  assert.equal(existsSync(f.recoveryFile),false);
 }finally{chmodSync(f.root,0o700);rmSync(f.root,{recursive:true,force:true});}
});

test('issuer refuses an active runtime lock and leaves existing custody untouched',async()=>{
 const f=fixture();try{
  const a=new OwnerAuthority(f.options);await a.claimWithPassword({assertion:f.assertion,password:opaque()});
  writeFileSync(join(f.state,'runtime.lock'),'active',{mode:0o600});
  assert.throws(()=>issueOwnerInvitation(f.input));
  assert.equal(readFileSync(join(f.state,'runtime.lock'),'utf8'),'active');
  assert.equal(existsSync(f.keyFile),false);assert.equal(existsSync(f.recoveryFile),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('issuer rejects relative inputs and output paths inside the served bundle',async()=>{
 const f=fixture();try{
  const a=new OwnerAuthority(f.options);await a.claimWithPassword({assertion:f.assertion,password:opaque()});
  assert.throws(()=>issueOwnerInvitation({...f.input,keyFile:'relative-key.txt'}));
  assert.throws(()=>issueOwnerInvitation({...f.input,keyFile:join(f.bundle,'key.txt')}));
  assert.equal(existsSync(f.keyFile),false);assert.equal(existsSync(f.recoveryFile),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
