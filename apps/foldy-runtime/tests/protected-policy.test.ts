import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReleaseBundle} from '../dist/release-bundle.js';
import {loadBundle,digest} from '../dist/bundle.js';
import {Domain} from '../dist/domain.js';
import {spawnSync} from 'node:child_process';
const owner={id:'owner',owner:true,scopes:[]};
const policyPath='runtime-policy.json';
function fixture(fn:any){const dir=mkdtempSync(join(tmpdir(),'protected-policy-'));const source=join(dir,'source');mkdirSync(source);const bytes=Buffer.from('<h1>protected</h1>');writeFileSync(join(source,'index.html'),bytes);const revision:any={instanceId:'i',projectId:'p',workbookId:'w',revisionId:'base',approvedRevisionId:'base',frozen:true,runtimeVersion:'0.1.0',runtimeImageDigest:'sha256:'+'a'.repeat(64),protectedPaths:['index.html'],members:[{path:'index.html',mediaType:'text/html',bytes:bytes.length,sha256:digest(bytes),executableMode:0}]};try{fn(dir,source,revision,{snapshot:()=>({revision,directory:source}),assertContentOnly:()=>{}});}finally{rmSync(dir,{recursive:true,force:true});}}
test('verified policy survives backup restore, reopen and denies owner edits and seed downgrade',()=>fixture((dir:any,source:any,revision:any,adapter:any)=>{
 const out=buildReleaseBundle(adapter,join(dir,'bundle'));const bundle=loadBundle(out.directory,out.bundleDigest);assert.deepEqual(bundle.protectedPaths,['index.html']);
 // Mutating the source after verification cannot replace snapshot policy.
 writeFileSync(join(source,'index.html'),'changed');rmSync(join(out.directory,policyPath));writeFileSync(join(out.directory,policyPath),JSON.stringify({schemaVersion:'foldy-runtime-policy.v1',protectedPaths:[]}));
 let d=new Domain(join(dir,'db'),bundle);const raw=d.backup(owner);d.close();Domain.restore(join(dir,'restored'),raw,owner,bundle.manifest);
 for(let pass=0;pass<2;pass++){d=new Domain(join(dir,'restored'),bundle);try{const a:any=d.dispatch('create_update',{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:'create'+pass,title:'proposal'},owner);for(const path of ['index.html',policyPath])for(const op of ['update_page','remove_page','move_page'])assert.throws(()=>d.dispatch(op,{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:op+path+pass,updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId,path,...(op==='update_page'?{content:'bad'}:op==='move_page'?{destinationPath:'other.txt'}:{})},owner),/PROTECTED_PATH/);}finally{d.close();}}
 const files=new Map(bundle.files);files.delete(policyPath);assert.throws(()=>new Domain(join(dir,'restored'),{manifest:bundle.manifest,files}),/POLICY_MISMATCH/);
}));
for(const descendants of [false,true])for(const mutation of ['content','mediaType','policy-serialization'])test(`reopen authenticates protected seed bytes and type: ${mutation}, descendants=${descendants}`,()=>fixture((dir:any,source:any,revision:any,adapter:any)=>{
 const out=buildReleaseBundle(adapter,join(dir,'bundle'));const bundle=loadBundle(out.directory,out.bundleDigest);
 const d=new Domain(join(dir,'db'),bundle);
 if(descendants)d.dispatch('create_update',{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:'create',title:'draft'},owner);
 const backup=JSON.parse(d.backup(owner));d.close();
 for(const r of backup.payload.revisions){
  const f=r.files[mutation==='policy-serialization'?policyPath:'index.html'];
  if(mutation==='mediaType')f.mediaType='text/plain';
  else f.content=Buffer.from(mutation==='content'?'<h1>attacker</h1>':JSON.stringify(JSON.parse(Buffer.from(f.content,'base64').toString()),null,2)).toString('base64');
  f.sha256=digest(Buffer.from(f.content,'base64'));
 }
 backup.sha256=digest(JSON.stringify(backup.payload));
 const target=join(dir,'restored');Domain.restore(target,JSON.stringify(backup),owner,bundle.manifest);
 assert.throws(()=>{const reopened=new Domain(target,bundle);reopened.close();},/POLICY_MISMATCH/);
}));
test('loader rejects unknown versions, fields, duplicate and unsafe policy paths even with matching manifest hash',()=>fixture((dir:any,source:any,revision:any,adapter:any)=>{
 const out=buildReleaseBundle(adapter,join(dir,'bundle'));
 for(const policy of [{schemaVersion:'future',protectedPaths:[]},{schemaVersion:'foldy-runtime-policy.v1',protectedPaths:['../bad']},{schemaVersion:'foldy-runtime-policy.v1',protectedPaths:['index.html','index.html']},{schemaVersion:'foldy-runtime-policy.v1',protectedPaths:[],fields:[]},{schemaVersion:'foldy-runtime-policy.v1',protectedPaths:'index.html'}]){
 const bytes=Buffer.from(JSON.stringify(policy));rmSync(join(out.directory,policyPath));rmSync(join(out.directory,'manifest.json'));writeFileSync(join(out.directory,policyPath),bytes);const m=structuredClone(out.manifest);const member=m.members.find((m:any)=>m.path===policyPath)!;member.bytes=bytes.length;member.sha256=digest(bytes);const manifest=JSON.stringify(m);writeFileSync(join(out.directory,'manifest.json'),manifest);assert.throws(()=>loadBundle(out.directory,digest(manifest)),/POLICY_INVALID/);
 const child=spawnSync(process.execPath,['dist/main.js'],{env:{...process.env,FOLDY_BUNDLE_DIR:out.directory,FOLDY_BUNDLE_DIGEST:digest(manifest)},encoding:'utf8',timeout:5000});assert.equal(child.status,1);assert.match(child.stderr,/FOLDY_START_FAILED/);assert.ok(!child.stdout.includes('FOLDY_LISTENING'));
 }
}));
test('export preserves approved policy member and rejects a conflicting replacement',()=>fixture((dir:any,source:any,revision:any,adapter:any)=>{
 const bytes=Buffer.from(JSON.stringify({schemaVersion:'foldy-runtime-policy.v1',protectedPaths:['index.html']}));writeFileSync(join(source,policyPath),bytes);revision.members.push({path:policyPath,mediaType:'application/json',bytes:bytes.length,sha256:digest(bytes),executableMode:0});const out=buildReleaseBundle(adapter,join(dir,'bundle'));assert.deepEqual(loadBundle(out.directory,out.bundleDigest).files.get(policyPath)!.bytes,bytes);revision.protectedPaths=[];assert.throws(()=>buildReleaseBundle(adapter,join(dir,'bad')),/POLICY_MISMATCH/);
}));
