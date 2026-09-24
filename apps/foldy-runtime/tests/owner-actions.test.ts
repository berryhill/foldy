import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Domain } from '../dist/domain.js';
import { loadBundle } from '../dist/bundle.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const opaque=()=>randomBytes(32).toString('hex');

test('real process backup is owner-only, restores content, and logout/recovery revoke old authority',async()=>{
 const root=mkdtempSync(join(tmpdir(),'foldy-actions-'));chmodSync(root,0o700);
 const bundle=join(root,'bundle'),state=join(root,'state');for(const dir of [bundle,state])mkdirSync(dir,{mode:0o700});
 const html='<!doctype html><h1>Backup roundtrip</h1>';
 const manifest={schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'workbook-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]};
 const raw=JSON.stringify(manifest),assertion=opaque(),recovery=opaque(),password=opaque();
 writeFileSync(join(bundle,'index.html'),html);writeFileSync(join(bundle,'manifest.json'),raw);
 writeFileSync(join(root,'bootstrap.json'),JSON.stringify({instanceId:manifest.instanceId,verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 // Deploying-principal recovery custody, not a source-level authentication bypass.
 writeFileSync(join(root,'recovery.json'),JSON.stringify({schemaVersion:'foldy-owner-recovery.v1',instanceId:manifest.instanceId,bundleDigest:hash(raw),generation:1,nonce:opaque(),verifier:hash(recovery),expiresAt:Date.now()+600000}),{mode:0o600});
 const child=spawn(process.execPath,[resolve('dist/main.js')],{env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(raw),FOLDY_STATE_DIR:state,FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_OWNER_RECOVERY_FILE:join(root,'recovery.json'),FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0',FOLDY_EXTERNAL_CACHE_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 try{
 let port='';for(let i=0;i<150;i++){port=logs.match(/FOLDY_LISTENING (\d+)/)?.[1]||'';if(port||child.exitCode!==null)break;await new Promise(r=>setTimeout(r,20));}assert.ok(port,'runtime starts');
 const url=`http://127.0.0.1:${port}`;
 const post=(path:string,data:unknown,cookie='',origin=url)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',origin,cookie},body:JSON.stringify(data)});
 const get=(cookie='',extra:Record<string,string>={})=>fetch(url+'/api/backup',{headers:{cookie,...extra}});
 assert.equal((await get()).status,401);
 const claimed=await post('/api/claim',{assertion});assert.equal(claimed.status,200);const owner=claimed.headers.get('set-cookie')!.split(';')[0];
 assert.equal((await post('/api/owner/viewer-access',{mode:'password_required',password},owner)).status,200);
 const unlocked=await post('/api/viewer/unlock',{password});assert.equal(unlocked.status,200);const viewer=unlocked.headers.get('set-cookie')!.split(';')[0];
 const granted=await post('/api/mcp-grants',{},owner);const grant=await granted.json();
 for(const headers of [{},{cookie:viewer},{authorization:`Bearer ${grant.token}`},{cookie:'__Host-foldy-owner='+assertion}]){
 const denied=await fetch(url+'/api/backup',{headers});assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{code:'AUTH_REQUIRED'});assert.equal(denied.headers.get('cache-control'),'no-store');assert.equal(denied.headers.get('content-disposition'),null);
 }
 assert.equal((await get(owner,{origin:'https://other.invalid'})).status,403);
 assert.equal((await post('/api/backup',{},owner)).status,405);
 const download=await get(owner);assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'no-store');assert.match(download.headers.get('content-disposition')!,/^attachment; filename="foldy-backup\.json"$/);assert.match(download.headers.get('content-type')!,/application\/json/);
 const backup=await download.text();for(const secret of [assertion,recovery,password,grant.token,owner.split('=')[1]])assert.ok(!backup.includes(secret));
 const actor={id:'owner',owner:true,scopes:[]},target=join(root,'restored.sqlite');
 const receipt=Domain.restore(target,backup,actor,manifest);assert.equal(receipt.state,'SEALED');
 const restored=new Domain(target,loadBundle(bundle,hash(raw)));try{assert.equal(restored.current(),manifest.revisionId);assert.equal(restored.file('index.html')!.bytes.toString(),html);assert.equal(restored.requiresAccessConfiguration(),true);}finally{restored.close();}
 assert.equal((await post('/api/viewer/logout',{},viewer)).status,200);assert.equal((await fetch(url+'/',{headers:{cookie:viewer}})).status,401);
 assert.equal((await post('/api/owner/logout',{},owner)).status,200);assert.equal((await get(owner)).status,401);
 assert.equal((await post('/api/owner/recover',{password:recovery})).status,401);
 const recovered=await post('/api/owner/recover',{assertion:recovery});assert.equal(recovered.status,200);const fresh=recovered.headers.get('set-cookie')!.split(';')[0];assert.equal((await get(fresh)).status,200);assert.equal((await get(owner)).status,401);assert.equal((await post('/api/owner/recover',{assertion:recovery})).status,401);
 const script=await(await fetch(url+'/owner/app.js')).text();for(const path of ['/api/backup','/api/viewer/logout','/api/owner/logout','/api/owner/recover'])assert.ok(script.includes(path),path);
 for(const label of ['Download backup','Log out of viewing','Log out of owner workspace','Recover owner access'])assert.ok(script.includes(label),label);
 assert.ok(!/localStorage|innerHTML/.test(script));assert.match(script,/credentials:'same-origin'/);
 for(const path of ['/owner','/unlock']){const page=await fetch(url+path);assert.match(page.headers.get('content-security-policy')!,/script-src 'nonce-/);const text=await page.text();assert.match(text,/<script nonce="[^"]+" src="\/owner\/app.js"/);}
 for(const secret of [assertion,recovery,password,grant.token])assert.ok(!logs.includes(secret));
 }finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}rmSync(root,{recursive:true,force:true});}
});
