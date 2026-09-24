import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'foldy-runtime-'));
  const bundle = join(root, 'bundle'); mkdirSync(bundle); mkdirSync(join(root,'state'),{mode:0o700});
  const html = '<!doctype html><h1>Immutable Foldy</h1>';
  writeFileSync(join(bundle,'index.html'),html);
  const manifest = { schemaVersion:'foldy-release-bundle.v1', instanceId:'instance-1',projectId:'project-1',workbookId:'workbook-1', revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}] };
  const raw = JSON.stringify(manifest); writeFileSync(join(bundle,'manifest.json'),raw);
  const assertion = randomBytes(32).toString('hex');
  writeFileSync(join(root,'bootstrap.json'),JSON.stringify({instanceId:'instance-1',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
  return {root,bundle,manifest,assertion,env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(raw),FOLDY_STATE_DIR:join(root,'state'),FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0'}};
}
async function launch(f: ReturnType<typeof fixture>) {
 const child = spawn(process.execPath,[resolve('dist/main.js')],{env:f.env,stdio:['ignore','pipe','pipe']});
 let logs=''; child.stdout.on('data',c=>logs+=c); child.stderr.on('data',c=>logs+=c);
 for(let i=0;i<100;i++){ const m=logs.match(/FOLDY_LISTENING (\d+)/); if(m) return {child,url:`http://127.0.0.1:${m[1]}`,logs:()=>logs}; if(child.exitCode!==null) break; await new Promise(r=>setTimeout(r,20)); }
 child.kill(); assert.fail('runtime must start and expose a listener (no credentials logged)');
}
const post = (url:string,body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
test('sealed bootstrap, owner/viewer/MCP separation, real protocol, immutable bytes and restart replay',async()=>{
 const f=fixture(); let p:Awaited<ReturnType<typeof launch>>|undefined;
 try {
 p=await launch(f); const u=p.url;
 assert.equal((await fetch(u+'/')).status,423);
 assert.deepEqual(await (await fetch(u+'/api/health')).json(),{live:true});
 assert.equal((await fetch(u+'/api/readiness')).status,401);
 assert.equal((await post(u+'/api/claim',{})).status,401);
 assert.equal((await fetch(u+'/mcp')).status,423);
 const claimed=await post(u+'/api/claim',{assertion:f.assertion}); assert.equal(claimed.status,200);
 const cookie=claimed.headers.get('set-cookie')!; assert.match(cookie,/Secure/); assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
 const owner={cookie:cookie.split(';')[0]};
 assert.equal((await post(u+'/api/claim',{assertion:f.assertion})).status,409);
 assert.equal((await fetch(u+'/api/readiness',{headers:owner})).status,200);
 assert.equal(await (await fetch(u+'/')).text(),'<!doctype html><h1>Immutable Foldy</h1>');
 const rival=spawn(process.execPath,[resolve('dist/main.js')],{env:f.env,stdio:'ignore'});
 const race=await Promise.race([once(rival,'exit').then(([code])=>code),new Promise(r=>setTimeout(()=>r('still-running'),750))]);
 rival.kill(); assert.notEqual(race,'still-running','a second process must not own the same state');
 writeFileSync(join(f.bundle,'index.html'),'tampered');
 assert.match(await (await fetch(u+'/')).text(),/Immutable Foldy/);
 assert.equal((await post(u+'/api/mcp-grants',{})).status,401);
 const issued=await post(u+'/api/mcp-grants',{},owner); assert.equal(issued.status,201); const grant=await issued.json();
 assert.equal((await fetch(u+'/api/readiness',{headers:{authorization:`Bearer ${grant.token}`}})).status,401);
 assert.equal((await post(u+'/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'proof',version:'1'}}},owner)).status,401);
 const auth={authorization:`Bearer ${grant.token}`,accept:'application/json, text/event-stream'};
 const init=await post(u+'/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'proof',version:'1'}}},auth);
 assert.equal(init.status,200); const initialized=await init.json(); assert.equal(initialized.result.protocolVersion,'2025-03-26');
 const session={...auth,'mcp-session-id':init.headers.get('mcp-session-id')!,'mcp-protocol-version':'2025-03-26'};
 assert.ok(session['mcp-session-id']);
 await post(u+'/mcp',{jsonrpc:'2.0',method:'notifications/initialized'},session);
 const tools=await (await post(u+'/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},session)).json();
 assert.ok(tools.result.tools.some((t:any)=>t.name==='get_update')); assert.ok(tools.result.tools.every((t:any)=>!['create_update','approve_update_revision','publish_update','close_update'].includes(t.name)));
 const read=await (await post(u+'/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_file',arguments:{path:'index.html',atRevisionId:'revision-1'}}},session)).json();
 assert.equal(JSON.parse(read.result.content[0].text).observedRevisionId,'revision-1');
 for(const args of [{path:'../bootstrap.json'},{path:'index.html',atRevisionId:'missing'},{path:'index.html',unknown:true}]) {
 const r=await (await post(u+'/mcp',{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_file',arguments:args}},session)).json(); assert.ok(r.error || r.result.isError);
 }
 const denied=await (await post(u+'/mcp',{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'publish_update',arguments:{}}},session)).json(); assert.ok(denied.error||denied.result.isError);
 assert.equal((await post(u+'/api/mcp-grants/revoke',{grantId:grant.grantId},owner)).status,200);
 assert.equal((await post(u+'/mcp',{jsonrpc:'2.0',id:6,method:'tools/list'},session)).status,401);
 assert.ok(!p.logs().includes(f.assertion)); assert.ok(!p.logs().includes(grant.token));
 const exit=once(p.child,'exit');p.child.kill(); await exit;
 writeFileSync(join(f.bundle,'index.html'),'<!doctype html><h1>Immutable Foldy</h1>');
 p=await launch(f); assert.equal((await post(p.url+'/api/claim',{assertion:f.assertion})).status,409);
 } finally {p?.child.kill();rmSync(f.root,{recursive:true,force:true});}
});
test('owner status and diagnostics expose durable backup evidence but no content or credentials',async()=>{
 const f=fixture();let p:Awaited<ReturnType<typeof launch>>|undefined;
 try {
 p=await launch(f);
 for(const path of ['/api/owner/status','/api/owner/diagnostics'])assert.equal((await fetch(p.url+path)).status,401);
 const claimed=await post(p.url+'/api/claim',{assertion:f.assertion});const owner={cookie:claimed.headers.get('set-cookie')!.split(';')[0]};
 const initial=await(await fetch(p.url+'/api/owner/status',{headers:owner})).json();assert.equal(initial.operations.lastBackup,null);assert.equal(initial.lease.state,'unverified');
 assert.equal((await fetch(p.url+'/api/backup',{headers:owner})).status,200);
 const invalid=await post(p.url+'/api/operations',{name:'unknown',arguments:{}},owner);assert.equal(invalid.status,400);const failed=await invalid.json();
 const report=await fetch(p.url+'/api/owner/diagnostics',{headers:owner});assert.match(report.headers.get('content-disposition')!,/attachment/);const text=await report.text(),status=JSON.parse(text);
 assert.equal(status.operations.lastBackup.revisionId,'revision-1');assert.equal(status.operations.latestFailure.requestId,failed.requestId);
 assert.ok(!text.includes(f.assertion));assert.ok(!text.includes(owner.cookie));assert.ok(!text.includes('Immutable Foldy'));assert.equal(status.runtimeImageDigest,f.manifest.runtimeImageDigest);
 const exit=once(p.child,'exit');p.child.kill();await exit;p=await launch(f);
 const restarted=await(await fetch(p.url+'/api/owner/status',{headers:owner})).json();assert.deepEqual(restarted.operations,status.operations);
 }finally{p?.child.kill();rmSync(f.root,{recursive:true,force:true});}
});
test('expired protected bootstrap remains SEALED',async()=>{
 const f=fixture();let p:Awaited<ReturnType<typeof launch>>|undefined;
 try{writeFileSync(join(f.root,'bootstrap.json'),JSON.stringify({instanceId:'instance-1',verifier:hash(f.assertion),expiresAt:Date.now()-1}),{mode:0o600});p=await launch(f);assert.equal((await post(p.url+'/api/claim',{assertion:f.assertion})).status,401);assert.equal((await fetch(p.url+'/')).status,423);}finally{p?.child.kill();rmSync(f.root,{recursive:true,force:true});}
});
for(const corruption of ['hash','traversal','symlink','undeclared','bootstrap-leak'] as const) test(`reject ${corruption} bundle before listening`,async()=>{
 const f=fixture();
 try {
 if(corruption==='hash')writeFileSync(join(f.bundle,'index.html'),'bad');
 if(corruption==='symlink'){rmSync(join(f.bundle,'index.html'));symlinkSync(join(f.root,'bootstrap.json'),join(f.bundle,'index.html'));}
 if(corruption==='undeclared')writeFileSync(join(f.bundle,'secret.txt'),'not declared');
 if(corruption==='traversal'){f.manifest.members[0].path='../bootstrap.json';const raw=JSON.stringify(f.manifest);writeFileSync(join(f.bundle,'manifest.json'),raw);f.env.FOLDY_BUNDLE_DIGEST=hash(raw);}
 if(corruption==='bootstrap-leak'){const leaked=readFileSync(join(f.root,'bootstrap.json'));writeFileSync(join(f.bundle,'index.html'),leaked);f.manifest.members[0].sha256=hash(leaked);f.manifest.members[0].bytes=leaked.length;const raw=JSON.stringify(f.manifest);writeFileSync(join(f.bundle,'manifest.json'),raw);f.env.FOLDY_BUNDLE_DIGEST=hash(raw);}
 const child=spawn(process.execPath,[resolve('dist/main.js')],{env:f.env,stdio:['ignore','pipe','pipe']}); let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 const result=await Promise.race([once(child,'exit').then(([code])=>code),new Promise(r=>setTimeout(()=>r('still-running'),1000))]);child.kill();assert.notEqual(result,'still-running');assert.notEqual(result,0);assert.ok(logs.includes('FOLDY_START_FAILED'));assert.ok(!logs.includes('FOLDY_LISTENING'));assert.ok(!logs.includes(f.assertion));
 } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('MCP draft and owner publish share persistent domain and change live bytes',async()=>{
 const f=fixture();let p:Awaited<ReturnType<typeof launch>>|undefined;
 try{
 p=await launch(f);const claimed=await post(p.url+'/api/claim',{assertion:f.assertion});const owner={cookie:claimed.headers.get('set-cookie')!.split(';')[0]};
 assert.equal((await post(p.url+'/api/mcp-grants',{scopes:['foldy:read','foldy:publish']},owner)).status,400);
 const grant=await (await post(p.url+'/api/mcp-grants',{scopes:['foldy:read','foldy:draft:write']},owner)).json();
 const auth={authorization:`Bearer ${grant.token}`,accept:'application/json, text/event-stream'};
 const init=await post(p.url+'/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'draft-proof',version:'1'}}},auth);
 const session={...auth,'mcp-session-id':init.headers.get('mcp-session-id')!,'mcp-protocol-version':'2025-03-26'};
 await post(p.url+'/mcp',{jsonrpc:'2.0',method:'notifications/initialized'},session);let n=1;
 const rpc=async(name:string,args:unknown)=> (await post(p!.url+'/mcp',{jsonrpc:'2.0',id:++n,method:'tools/call',params:{name,arguments:args}},session)).json();
 const call=async(name:string,args:unknown)=>{const r=await rpc(name,args);assert.ok(!r.error&&!r.result.isError);return JSON.parse(r.result.content[0].text);};
 const base={projectId:'project-1',expectedBaseRevisionId:'revision-1'};
 const created=await call('create_update',{...base,title:'Live update',idempotencyKey:'create'});let ref={...base,updateId:created.updateId,expectedUpdateRevisionId:created.updateRevisionId};
 const edit=await call('update_page',{...ref,path:'index.html',content:'<!doctype html><h1>Published live</h1>',idempotencyKey:'edit'});ref.expectedUpdateRevisionId=edit.updateRevisionId;
 assert.match(await (await fetch(p.url+'/')).text(),/Immutable Foldy/);
 const op=async(name:string,args:unknown)=>(await post(p!.url+'/api/operations',{name,arguments:args},owner)).json();
 const reviewed=await op('get_update',{projectId:'project-1',updateId:created.updateId});assert.equal(reviewed.value.revision,edit.updateRevisionId);
 for(const name of ['approve_update_revision','publish_update','close_update']){const denied=await rpc(name,{...ref,idempotencyKey:name,reason:'attempt'});assert.ok(denied.error||denied.result.isError);}
 assert.equal((await post(p.url+'/api/operations',{name:'publish_update',arguments:{}},auth)).status,401);
 await call('submit_update_for_review',{...ref,idempotencyKey:'submit'});
 assert.equal((await op('approve_update_revision',{...ref,idempotencyKey:'approve',reason:'reviewed exact proposal'})).currentState,'Approved');
 const changed=await call('update_page',{...ref,path:'index.html',content:'<!doctype html><h1>Published live</h1><p>Reviewed again</p>',idempotencyKey:'second-edit'});ref.expectedUpdateRevisionId=changed.updateRevisionId;
 assert.equal((await op('publish_update',{...ref,idempotencyKey:'stale',reason:'must fail'})).code,'APPROVAL_STALE');
 await call('submit_update_for_review',{...ref,idempotencyKey:'resubmit'});await op('approve_update_revision',{...ref,idempotencyKey:'reapprove',reason:'reviewed again'});
 const rival=await call('create_update',{...base,title:'Concurrent proposal',idempotencyKey:'rival'});const rivalRef={...base,updateId:rival.updateId,expectedUpdateRevisionId:rival.updateRevisionId};await call('submit_update_for_review',{...rivalRef,idempotencyKey:'rival-submit'});await op('approve_update_revision',{...rivalRef,idempotencyKey:'rival-approve',reason:'reviewed'});
 const pubArgs={...ref,idempotencyKey:'publish',reason:'publish reviewed proposal'};const published=await op('publish_update',pubArgs);assert.equal(published.currentState,'Published');assert.deepEqual(await op('publish_update',pubArgs),published);
 assert.equal((await op('publish_update',{...rivalRef,idempotencyKey:'rival-publish',reason:'must conflict'})).code,'REVISION_CONFLICT');
 assert.match(await (await fetch(p.url+'/')).text(),/Published live/);
 assert.equal((await (await fetch(p.url+'/mcp/manifest.json')).json()).currentPublishedRevisionId,published.updateRevisionId);
 const old=await call('get_file',{path:'index.html',atRevisionId:'revision-1'});assert.match(Buffer.from(old.value.bytes,'base64').toString(),/Immutable Foldy/);
 const exit=once(p.child,'exit');p.child.kill();await exit;p=await launch(f);assert.match(await (await fetch(p.url+'/')).text(),/Published live/);
 assert.equal((await op('get_update',{updateId:created.updateId})).value.state,'Published');assert.deepEqual(await op('publish_update',pubArgs),published);
 }finally{if(p){const exit=once(p.child,'exit');p.child.kill();await exit;}rmSync(f.root,{recursive:true,force:true});}
});
