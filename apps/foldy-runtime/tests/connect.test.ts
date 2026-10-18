import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { grantEvidence, tunnelBinding } from '../dist/connect.js';

const hash = (value:string) => createHash('sha256').update(value).digest('hex');
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'foldy-connect-')), bundle=join(root,'bundle'), state=join(root,'state');
 mkdirSync(bundle);mkdirSync(state,{mode:0o700});
 const html='<!doctype html><h1>Connect test content</h1>';writeFileSync(join(bundle,'index.html'),html);
 const manifest=JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-connect',projectId:'project-connect',workbookId:'workbook-connect',revisionId:'revision-connect',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]});
 writeFileSync(join(bundle,'manifest.json'),manifest);
 const assertion=randomBytes(32).toString('hex');writeFileSync(join(root,'bootstrap.json'),JSON.stringify({instanceId:'instance-connect',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 return {root,state,assertion,env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(manifest),FOLDY_STATE_DIR:state,FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0'}};
}
async function launch(env:NodeJS.ProcessEnv) {
 const child=spawn(process.execPath,[resolve('dist/main.js')],{env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 for(let i=0;i<150;i++){const m=/FOLDY_LISTENING (\d+)/.exec(logs);if(m)return {child,origin:`http://127.0.0.1:${m[1]}`,logs:()=>logs};if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,20));}
 child.kill();throw Error('TEST_START_FAILED: '+logs);
}
async function stop(child:ReturnType<typeof spawn>){if(child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}}
const post=(origin:string,path:string,value:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});

test('protected tunnel reference validates shape without accessing credential file',()=>{
 const f=fixture(),privateDir=join(f.root,'operator');mkdirSync(privateDir,{mode:0o700});const path=join(privateDir,'tunnel.json');
 const binding={schemaVersion:'foldy-secure-mcp-tunnel.v1',tunnelId:'tunnel_0123456789abcdef0123456789abcdef',credentialFile:join(privateDir,'unreadable-and-absent.key')};
 try {
  assert.equal(tunnelBinding(undefined),null);
  writeFileSync(path,JSON.stringify(binding),{mode:0o600});assert.deepEqual(tunnelBinding(path),{tunnelId:binding.tunnelId,credentialFile:binding.credentialFile});
  for(const invalid of [{...binding,extra:true},{...binding,tunnelId:'placeholder'},{...binding,credentialFile:'relative'},{...binding,schemaVersion:'other'}]){writeFileSync(path,JSON.stringify(invalid));assert.throws(()=>tunnelBinding(path));}
  writeFileSync(path,JSON.stringify(binding));chmodSync(path,0o644);assert.throws(()=>tunnelBinding(path));
  assert.throws(()=>tunnelBinding('relative.json'));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('configured tunnel is owner-only and never reported independently online',async()=>{
 const f=fixture(),privateDir=join(f.root,'operator');mkdirSync(privateDir,{mode:0o700});
 const path=join(privateDir,'tunnel.json'),tunnelId='tunnel_0123456789abcdef0123456789abcdef';
 writeFileSync(path,JSON.stringify({schemaVersion:'foldy-secure-mcp-tunnel.v1',tunnelId,credentialFile:join(privateDir,'absent.key')}),{mode:0o600});
 let runtime:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  runtime=await launch({...f.env,FOLDY_SECURE_MCP_TUNNEL_BINDING_FILE:path});const {origin}=runtime;
  const publicText=await (await fetch(origin+'/api/connect')).text();
  assert.equal(JSON.parse(publicText).transport,'configured-not-verified');
  assert.equal(JSON.parse(publicText).chatgptReady,false);
  assert.ok(!publicText.includes(tunnelId)&&!publicText.includes(path));
  assert.equal((await fetch(origin+'/api/connect/tunnel')).status,401);
  const claim=await post(origin,'/api/claim',{assertion:f.assertion,password:randomBytes(24).toString('hex')});
  assert.equal(claim.status,200);
  const owner={cookie:claim.headers.get('set-cookie')!.split(';')[0],origin};
  assert.deepEqual(await (await fetch(origin+'/api/connect/tunnel',{headers:owner})).json(),{schemaVersion:'foldy-secure-mcp-tunnel-status.v1',state:'configured-not-verified',tunnelId,onlineVerified:false});
 }finally{if(runtime)await stop(runtime.child);rmSync(f.root,{recursive:true,force:true});}
});

test('unconfigured public discovery remains generic; owner evidence follows actual MCP calls and survives restart',async()=>{
 const f=fixture();let runtime:Awaited<ReturnType<typeof launch>>|undefined;
 try {
  runtime=await launch(f.env);let {origin}=runtime;
  const page=await fetch(origin+'/connect');assert.equal(page.status,200);const pageText=await page.text();
  for(const label of ['Connect ChatGPT','Updates / Review','Connection Tunnel','Authorize','Verify','Iterate','Manage','Sign in to authorize'])assert.ok(pageText.includes(label),label);
  for(const forbidden of ['instance-connect','project-connect','workbook-connect',f.assertion,'/_document/index.html'])assert.ok(!pageText.includes(forbidden),forbidden);
  assert.match(page.headers.get('content-security-policy')!,/script-src 'nonce-/);
  const client=await fetch(origin+'/connect/app.js');assert.equal(client.status,200);const clientSource=await client.text();new Function(clientSource);
  assert.ok(!clientSource.includes('innerHTML')&&!clientSource.includes('localStorage'));
  assert.match(clientSource,/clearPrivate\(\)/);assert.match(clientSource,/\/api\/connect\/status/);
  assert.equal((await fetch(origin+'/mcp/manifest.json')).status,423);
  const publicText=await (await fetch(origin+'/api/connect')).text();const publicValue=JSON.parse(publicText);
  assert.equal(publicValue.transport,'unconfigured');assert.equal(publicValue.chatgptReady,false);
  for(const forbidden of ['instance-connect','project-connect','workbook-connect','revision-connect',f.assertion,'grantId','session','tunnelId'])assert.ok(!publicText.includes(forbidden),forbidden);
  assert.equal((await fetch(origin+'/api/connect/status')).status,401);assert.equal((await fetch(origin+'/api/connect/tunnel')).status,401);
  const claim=await post(origin,'/api/claim',{assertion:f.assertion,password:randomBytes(24).toString('hex')});assert.equal(claim.status,200);
  const owner={cookie:claim.headers.get('set-cookie')!.split(';')[0],origin};
  assert.equal((await fetch(origin+'/mcp/manifest.json')).status,401);
  const manifest=await fetch(origin+'/mcp/manifest.json',{headers:owner});assert.equal(manifest.status,200);assert.equal((await manifest.json()).projectId,'project-connect');
  const tunnel=await (await fetch(origin+'/api/connect/tunnel',{headers:owner})).json();assert.deepEqual(tunnel,{schemaVersion:'foldy-secure-mcp-tunnel-status.v1',state:'unconfigured',tunnelId:null,onlineVerified:false});
  const grant=await (await post(origin,'/api/mcp-grants',{scopes:['foldy:read','foldy:draft:write']},owner)).json();
  const readOnly=await (await post(origin,'/api/mcp-grants',{},owner)).json();
  const status=()=>fetch(origin+'/api/connect/status',{headers:owner}).then(r=>r.json());
  const row=async(id:string)=>(await status()).grants.find((g:any)=>g.grantId===id);
  assert.equal((await row(grant.grantId)).verified,false);
  const auth={authorization:'Bearer '+grant.token,accept:'application/json, text/event-stream'};
  const init=await post(origin,'/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'evidence',version:'1'}}},auth);assert.equal(init.status,200);
  const session={...auth,'mcp-session-id':init.headers.get('mcp-session-id')!,'mcp-protocol-version':'2025-03-26'};
  await post(origin,'/mcp',{jsonrpc:'2.0',method:'notifications/initialized'},session);
  await post(origin,'/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},session);
  assert.equal((await row(grant.grantId)).verified,false);
  const rpc=async(name:string,args:Record<string,unknown>)=>(await post(origin,'/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}},session)).json();
  assert.ok((await rpc('get_file',{path:'missing.html'})).error);assert.equal((await row(grant.grantId)).verified,false);
  assert.ok((await rpc('publish_update',{})).error);assert.equal((await row(grant.grantId)).lastSuccessfulDraftAt,null);
  const success=await rpc('get_project',{});assert.equal(JSON.parse(success.result.content[0].text).value.projectId,'project-connect');
  const readEvidence=await row(grant.grantId);assert.equal(readEvidence.verified,true);assert.ok(readEvidence.lastSuccessfulReadAt);assert.equal(readEvidence.lastSuccessfulDraftAt,null);
  const created=await rpc('create_update',{projectId:'project-connect',expectedBaseRevisionId:'revision-connect',idempotencyKey:'create-proof',title:'Proof'});
  assert.ok(created.result&&!created.result.isError);assert.ok((await row(grant.grantId)).lastSuccessfulDraftAt);
  const custody=readFileSync(join(f.state,'authority.json'),'utf8');assert.ok(!custody.includes(grant.token));assert.ok(!custody.includes('Connect test content'));assert.ok(!custody.includes('Proof'));
  assert.equal((await row(readOnly.grantId)).verified,false,'other grant must not inherit evidence');
  const readAuth={authorization:'Bearer '+readOnly.token,accept:'application/json, text/event-stream'};
  const readInit=await post(origin,'/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'read-only-negative',version:'1'}}},readAuth);
  const denied=await(await post(origin,'/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'create_update',arguments:{projectId:'project-connect',expectedBaseRevisionId:'revision-connect',idempotencyKey:'denied-proof',title:'Must not create'}}},{...readAuth,'mcp-session-id':readInit.headers.get('mcp-session-id')!,'mcp-protocol-version':'2025-03-26'})).json();
  assert.ok(denied.error);assert.equal((await row(readOnly.grantId)).lastSuccessfulDraftAt,null);
  await stop(runtime.child);runtime=await launch(f.env);origin=runtime.origin;owner.origin=origin;
  assert.equal((await row(grant.grantId)).lastSuccessfulReadAt,readEvidence.lastSuccessfulReadAt);
  assert.ok((await row(grant.grantId)).lastSuccessfulDraftAt);
  assert.equal((await post(origin,'/api/mcp-grants/revoke',{grantId:grant.grantId},{...owner,origin})).status,200);
  assert.equal(await row(grant.grantId),undefined);
  assert.equal((await row(readOnly.grantId)).verified,false);
 }finally{if(runtime)await stop(runtime.child);rmSync(f.root,{recursive:true,force:true});}
});

test('expired evidence is not verified',()=>{
 const grant={grantId:'x',verifier:hash('opaque'),expiresAt:100,scopes:['foldy:read','foldy:draft:write'],lastSuccessfulReadAt:50,lastSuccessfulDraftAt:60};
 assert.equal(grantEvidence(grant,99).verified,true);
 assert.deepEqual({verified:grantEvidence(grant,100).verified,read:grantEvidence(grant,100).lastSuccessfulReadAt,draft:grantEvidence(grant,100).lastSuccessfulDraftAt},{verified:false,read:null,draft:null});
});
