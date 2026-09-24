import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { digest, loadBundle } from '../dist/bundle.js';
import { Domain } from '../dist/domain.js';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { readActivation } from '../dist/upgrade.js';

test('fresh process upgrade and rollback preserve content/custody; substitution and active runtime denied',()=>{
 const root=mkdtempSync(join(tmpdir(),'foldy-upgrade-'));const state=join(root,'state');mkdirSync(state,{mode:0o700});
 const make=(name:string,image:string,content='<h1>Approved</h1>')=>{const directory=join(root,name);mkdirSync(directory,{mode:0o700});const bytes=Buffer.from(content);writeFileSync(join(directory,'index.html'),bytes,{mode:0o600});const manifest={schemaVersion:'foldy-release-bundle.v1',instanceId:'i',projectId:'p',workbookId:'w',revisionId:'r',runtimeImageDigest:'sha256:'+image.repeat(64),members:[{path:'index.html',mediaType:'text/html',bytes:bytes.length,sha256:digest(bytes),executableMode:0}]};const raw=JSON.stringify(manifest);writeFileSync(join(directory,'manifest.json'),raw,{mode:0o600});return {directory,digest:digest(raw)};};
 try{
 const old=make('old','a'),next=make('next','b'),bad=make('bad','c','<h1>Unapproved</h1>');const d=new Domain(join(state,'content.sqlite'),loadBundle(old.directory,old.digest));const baseline=d.backup({id:'owner',owner:true,scopes:[]});d.close();chmodSync(join(state,'content.sqlite'),0o600);
 const authority=JSON.stringify({instanceId:'i',bundleDigest:old.digest,ownerVerifier:digest('synthetic-test-only'),ownerExpiresAt:Date.now()+60000,generation:1,grants:[]});writeFileSync(join(state,'authority.json'),authority,{mode:0o600});
 const run=(candidate:any,expectedGeneration:number,kind='upgrade')=>{const request={stateDirectory:state,incumbent:expectedGeneration===0?old:next,candidate,expectedGeneration,operationId:'op'+expectedGeneration,confirmation:'i',dataCompatibility:'foldy-runtime-domain.v1',kind};const path=join(root,'request.json');writeFileSync(path,JSON.stringify(request),{mode:0o600});return spawnSync(process.execPath,[resolve('dist/upgrade-cli.js'),path],{encoding:'utf8'});};
 assert.equal(run(bad,0).status,1);assert.equal(readActivation(state),undefined);
 writeFileSync(join(state,'runtime.lock'),'');assert.equal(run(next,0).status,1);rmSync(join(state,'runtime.lock'));
 const upgraded=run(next,0);assert.equal(upgraded.status,0,upgraded.stderr);assert.equal(readActivation(state)?.current.digest,next.digest);assert.equal(readFileSync(join(state,'authority.json'),'utf8'),authority);
 const reopened=spawnSync(process.execPath,['--input-type=module','-e',`import {activeBundle} from './dist/upgrade.js';import {Domain} from './dist/domain.js';const {bundle}=activeBundle(${JSON.stringify(state)},${JSON.stringify(old)});const d=new Domain(${JSON.stringify(join(state,'content.sqlite'))},bundle);console.log(d.backup({id:'owner',owner:true,scopes:[]}));d.close();`],{encoding:'utf8'});assert.equal(reopened.status,0,reopened.stderr);assert.equal(reopened.stdout.trim(),baseline);
 const rollback=run(old,1,'rollback');assert.equal(rollback.status,0,rollback.stderr);assert.equal(readActivation(state)?.current.digest,old.digest);assert.equal(readFileSync(join(state,'authority.json'),'utf8'),authority);
 }finally{rmSync(root,{recursive:true,force:true});}
});

function protectedFixture(){
 const root=mkdtempSync(join(tmpdir(),'foldy-upgrade-custody-')),state=join(root,'state');mkdirSync(state,{mode:0o700});
 const make=(name:string,image:string)=>{const directory=join(root,name);mkdirSync(join(directory,'a/b/c'),{recursive:true,mode:0o700});const files=['index.html','a/b/c/data.txt'];const members=files.map(path=>{const bytes=Buffer.from('approved');writeFileSync(join(directory,path),bytes,{mode:0o600});return {path,mediaType:path==='index.html'?'text/html':'text/plain',bytes:bytes.length,sha256:digest(bytes),executableMode:0};});const raw=JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'i',projectId:'p',workbookId:'w',revisionId:'r',runtimeImageDigest:'sha256:'+image.repeat(64),members});writeFileSync(join(directory,'manifest.json'),raw,{mode:0o600});return {directory,digest:digest(raw)};};
 const old=make('old','a'),next=make('next','b');const database=join(state,'content.sqlite');const d=new Domain(database,loadBundle(old.directory,old.digest));d.close();chmodSync(database,0o600);
 writeFileSync(join(state,'authority.json'),JSON.stringify({instanceId:'i',bundleDigest:old.digest,ownerVerifier:digest('synthetic-test-only'),ownerExpiresAt:Date.now()+60000,generation:1,grants:[]}),{mode:0o600});
 const request={stateDirectory:state,incumbent:old,candidate:next,expectedGeneration:0,operationId:'regression',confirmation:'i',dataCompatibility:'foldy-runtime-domain.v1',kind:'upgrade'};
 const requestPath=join(root,'request.json');writeFileSync(requestPath,JSON.stringify(request),{mode:0o600});
 return {root,state,old,next,database,request,run:()=>spawnSync(process.execPath,[resolve('dist/upgrade-cli.js'),requestPath],{encoding:'utf8',timeout:10000}),env:{...process.env,FOLDY_BUNDLE_DIR:old.directory,FOLDY_BUNDLE_DIGEST:old.digest,FOLDY_STATE_DIR:state,FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0',FOLDY_EXTERNAL_CACHE_ENABLED:'0'}};
}
function hashes(dir:string):unknown{return Object.fromEntries(readdirSync(dir).sort().map(name=>{const p=join(dir,name),s=lstatSync(p);return [name,s.isSymbolicLink()?['link',readlinkSync(p)]:s.isDirectory()?hashes(p):[s.mode,digest(readFileSync(p))]];}));}
for(const kind of ['empty','non-domain','symlink','public','identity','schema','sidecar','pending-wal'] as const)test('reject '+kind+' database without mutating existing files',()=>{
 const f=protectedFixture();try{
 if(kind==='empty')writeFileSync(f.database,'');
 if(kind==='schema'){const db=new DatabaseSync(f.database);db.exec('DROP TABLE receipts');db.close();}
 if(kind==='sidecar'){const outside=join(f.root,'outside-shm');writeFileSync(outside,'outside-sentinel',{mode:0o600});symlinkSync(outside,f.database+'-shm');}
 if(kind==='pending-wal')writeFileSync(f.database+'-wal','uncheckpointed',{mode:0o600});
 if(kind==='non-domain'){rmSync(f.database);const db=new DatabaseSync(f.database);db.exec('CREATE TABLE unrelated(value TEXT)');db.close();chmodSync(f.database,0o600);}
 if(kind==='symlink'){const outside=join(f.root,'outside.sqlite');writeFileSync(outside,readFileSync(f.database),{mode:0o600});rmSync(f.database);symlinkSync(outside,f.database);}
 if(kind==='public')chmodSync(f.database,0o644);
 if(kind==='identity'){const db=new DatabaseSync(f.database);db.prepare('UPDATE meta SET value=? WHERE key=?').run('["other","p","w","r"]','identity');db.close();}
 const before=hashes(f.root);assert.equal(f.run().status,1);assert.deepEqual(hashes(f.root),before);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('dangling activation pointer denies upgrade and fresh runtime startup',()=>{
 const f=protectedFixture();try{symlinkSync(join(f.root,'absent'),join(f.state,'runtime-activation.json'));const before=hashes(f.root);assert.throws(()=>readActivation(f.state));assert.equal(f.run().status,1);const runtime=spawnSync(process.execPath,[resolve('dist/main.js')],{env:f.env,encoding:'utf8',timeout:3000});assert.equal(runtime.status,1);assert.deepEqual(hashes(f.root),before);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('real runtime main excludes upgrade and second runtime process',async()=>{
 const f=protectedFixture();const child=spawn(process.execPath,[resolve('dist/main.js')],{env:f.env,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',()=>{});
 try{for(let i=0;i<150&&!logs.includes('FOLDY_LISTENING');i++){if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,20));}assert.match(logs,/FOLDY_LISTENING/);
 const before=hashes(f.root);assert.equal(f.run().status,1);const other=spawnSync(process.execPath,[resolve('dist/main.js')],{env:f.env,encoding:'utf8',timeout:3000});assert.equal(other.status,1);assert.deepEqual(hashes(f.root),before);
 }finally{if(child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}}
 try{assert.equal(f.run().status,0);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('nested directories are flushed bottom-up before activation rename',async()=>{
 const f=protectedFixture();const fs=await import('node:fs');const {syncBuiltinESMExports}=await import('node:module');const originalSync=fs.default.fsyncSync,originalRename=fs.default.renameSync;const synced:string[]=[];let committed=false;
 fs.default.fsyncSync=(fd:number)=>{const path=readlinkSync('/proc/self/fd/'+fd);if(lstatSync(path).isDirectory())synced.push(path);originalSync(fd);};
 fs.default.renameSync=(a:any,b:any)=>{if(String(b).endsWith('runtime-activation.json')){committed=true;const leaf=synced.find(p=>p.endsWith('/a/b/c'));assert.ok(leaf);const base=leaf.slice(0,-6);const expected=[leaf,base+'/a/b',base+'/a',base];for(let i=1;i<expected.length;i++)assert.ok(synced.indexOf(expected[i-1])<synced.indexOf(expected[i]),expected[i]+' must flush after child');assert.ok(synced.includes(f.state));const before=hashes(f.root);const runtime=spawnSync(process.execPath,[resolve('dist/main.js')],{env:f.env,encoding:'utf8',timeout:3000});assert.equal(runtime.status,1);assert.deepEqual(hashes(f.root),before);}return originalRename(a,b);};syncBuiltinESMExports();
 try{const {executeUpgrade}=await import('../dist/upgrade.js');executeUpgrade(f.request as any);assert.ok(committed);}finally{fs.default.fsyncSync=originalSync;fs.default.renameSync=originalRename;syncBuiltinESMExports();rmSync(f.root,{recursive:true,force:true});}
});