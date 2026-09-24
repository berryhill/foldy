import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { digest, loadBundle, policyBytes } from '../dist/bundle.js';
import { Domain } from '../dist/domain.js';
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'restore-cli-')),bundle=join(root,'bundle'),custody=join(root,'custody'),target=join(root,'target');
 mkdirSync(bundle);mkdirSync(custody,{mode:0o700});
 const html='<h1>Restored protected bytes</h1>',files=[['index.html',Buffer.from(html),'text/html'],['runtime-policy.json',policyBytes(['index.html']),'application/json']] as const;
 for(const [path,bytes] of files)writeFileSync(join(bundle,path),bytes);
 const manifest={schemaVersion:'foldy-release-bundle.v1',instanceId:'i',projectId:'p',workbookId:'w',revisionId:'r',runtimeImageDigest:'sha256:'+'a'.repeat(64),members:files.map(([path,bytes,mediaType])=>({path,bytes:bytes.length,mediaType,sha256:digest(bytes),executableMode:0}))};
 const raw=JSON.stringify(manifest),hash=digest(raw);writeFileSync(join(bundle,'manifest.json'),raw);
 const d=new Domain(join(root,'source.sqlite'),loadBundle(bundle,hash));const backup=d.backup({id:'owner',owner:true,scopes:[]});d.close();
 const backupFile=join(root,'backup.json'),authFile=join(custody,'authorization.json');writeFileSync(backupFile,backup,{mode:0o600});
 const auth={schemaVersion:'foldy-restore-authorization.v1',instanceId:'i',projectId:'p',workbookId:'w',bundleDigest:hash,backupDigest:digest(backup),expiresAt:Date.now()+600000,nonce:randomBytes(32).toString('hex'),custodyDirectory:custody,targetDirectory:target};
 const save=()=>writeFileSync(authFile,JSON.stringify(auth),{mode:0o600});save();
 const args=['dist/restore-cli.js','--backup-file',backupFile,'--bundle-dir',bundle,'--bundle-digest',hash,'--authorization-file',authFile,'--target-dir',target,'--json'];
 return {root,bundle,custody,target,html,hash,backupFile,authFile,auth,args,save};
}
const run=(f:ReturnType<typeof fixture>)=>spawnSync(process.execPath,f.args,{encoding:'utf8',timeout:10000});
for(const kind of ['wronghash','expired','targetexists','wrongbundle','wrongidentity'] as const)test(`restore denies ${kind} without changing existing bytes`,()=>{
 const f=fixture();try{
 if(kind==='wronghash')f.auth.backupDigest='0'.repeat(64);
 if(kind==='expired')f.auth.expiresAt=Date.now()-1;
 if(kind==='wrongbundle')f.auth.bundleDigest='0'.repeat(64);
 if(kind==='wrongidentity')f.auth.workbookId='other';
 if(kind==='targetexists'){mkdirSync(f.target);writeFileSync(join(f.target,'sentinel'),'preserve');}
 f.save();const before=readFileSync(f.backupFile);assert.equal(run(f).status,1);assert.deepEqual(readFileSync(f.backupFile),before);
 if(kind==='targetexists')assert.equal(readFileSync(join(f.target,'sentinel'),'utf8'),'preserve');else assert.equal(existsSync(f.target),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('fresh restore, durable replay denial, startup claim and explicit policy before bytes',async()=>{
 const f=fixture();let child:ReturnType<typeof spawn>|undefined;
 try{
 const result=run(f);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).state,'SEALED');
 assert.deepEqual(readdirSync(f.target),['content.sqlite']);
 const original=readFileSync(join(f.target,'content.sqlite'));assert.equal(run(f).status,1);assert.deepEqual(readFileSync(join(f.target,'content.sqlite')),original);
 // Removing the target cannot reset authorization consumption.
 rmSync(f.target,{recursive:true});assert.equal(run(f).status,1);assert.equal(existsSync(f.target),false);
 f.auth.nonce=randomBytes(32).toString('hex');f.save();assert.equal(run(f).status,0);
 const assertion=randomBytes(32).toString('hex'),bootstrap=join(f.root,'bootstrap.json');writeFileSync(bootstrap,JSON.stringify({instanceId:'i',verifier:digest(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 const env={...process.env,FOLDY_BUNDLE_DIR:f.bundle,FOLDY_BUNDLE_DIGEST:f.hash,FOLDY_STATE_DIR:f.target,FOLDY_BOOTSTRAP_FILE:bootstrap,FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0',FOLDY_EXTERNAL_CACHE_ENABLED:'0'};
 const launch=async()=>{child=spawn(process.execPath,[resolve('dist/main.js')],{env,stdio:['ignore','pipe','pipe']});let logs='';child.stdout!.on('data',c=>logs+=c);child.stderr!.on('data',c=>logs+=c);for(let n=0;n<150;n++){const m=logs.match(/FOLDY_LISTENING (\d+)/);if(m)return 'http://127.0.0.1:'+m[1];if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,20));}assert.fail('runtime startup failed');};
 let url=await launch();assert.equal((await fetch(url+'/')).status,423);
 const post=(path:string,body:unknown,cookie='')=>fetch(url+path,{method:'POST',headers:{origin:url,'content-type':'application/json',cookie},body:JSON.stringify(body)});
 const claim=await post('/api/claim',{assertion});assert.equal(claim.status,200);const cookie=claim.headers.get('set-cookie')!.split(';')[0];assert.equal((await fetch(url+'/')).status,423);
 assert.equal((await post('/api/mcp-grants',{},cookie)).status,423);
 assert.equal((await post('/api/operations',{name:'get_file',arguments:{projectId:'p',path:'index.html'}},cookie)).status,423);
 assert.equal((await fetch(url+'/api/backup',{headers:{cookie}})).status,423);
 let exit=once(child!,'exit');child!.kill();await exit;url=await launch();assert.equal((await fetch(url+'/')).status,423);
 assert.equal((await post('/api/mcp-grants',{},cookie)).status,423);
 assert.equal((await post('/api/owner/viewer-access',{mode:'public',confirmDisable:true},cookie)).status,200);
 assert.equal((await post('/api/mcp-grants',{},cookie)).status,201);
 assert.equal(await (await fetch(url+'/')).text(),f.html);
 exit=once(child!,'exit');child!.kill();await exit;child=undefined;
 const d=new Domain(join(f.target,'content.sqlite'),loadBundle(f.bundle,f.hash));try{assert.equal(d.requiresAccessConfiguration(),false);}finally{d.close();}
 }finally{if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}rmSync(f.root,{recursive:true,force:true});}
});
test('invalid backup after consume burns authorization without installing content',()=>{
 const f=fixture();try{
 writeFileSync(f.backupFile,'{}');f.auth.backupDigest=digest('{}');f.save();assert.equal(run(f).status,1);
 assert.equal(existsSync(join(f.target,'content.sqlite')),false);
 assert.equal(readdirSync(join(f.custody,'restore-used')).length,1);
 rmSync(f.target,{recursive:true});assert.equal(run(f).status,1);assert.equal(existsSync(f.target),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('moving authorization cannot relocate its replay journal',()=>{
 const f=fixture();try{
 const other=join(f.root,'other');mkdirSync(other,{mode:0o700});const copy=join(other,'authorization.json');writeFileSync(copy,readFileSync(f.authFile),{mode:0o600});f.args[f.args.indexOf('--authorization-file')+1]=copy;
 assert.equal(run(f).status,1);assert.equal(existsSync(f.target),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('concurrent authorization consumption admits at most one restore',async()=>{
 const f=fixture();try{
 const children=[spawn(process.execPath,f.args,{stdio:'ignore'}),spawn(process.execPath,f.args,{stdio:'ignore'})];
 const codes=await Promise.all(children.map(c=>once(c,'exit').then(([code])=>code)));assert.deepEqual(codes.sort(),[0,1]);
 assert.equal(readdirSync(join(f.custody,'restore-used')).length,1);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
