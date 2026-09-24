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
  return {root,bundle,manifest,assertion,env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(raw),FOLDY_STATE_DIR:join(root,'state'),FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0',FOLDY_EXTERNAL_CACHE_ENABLED:'0'}};
}
async function launch(f: ReturnType<typeof fixture>) {
 const child = spawn(process.execPath,[resolve('dist/main.js')],{env:f.env,stdio:['ignore','pipe','pipe']});
 let logs=''; child.stdout.on('data',c=>logs+=c); child.stderr.on('data',c=>logs+=c);
 for(let i=0;i<100;i++){ const m=logs.match(/FOLDY_LISTENING (\d+)/); if(m) return {child,url:`http://127.0.0.1:${m[1]}`,logs:()=>logs}; if(child.exitCode!==null) break; await new Promise(r=>setTimeout(r,20)); }
 child.kill(); assert.fail('runtime must start and expose a listener (no credentials logged)');
}
const post = (url:string,body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
test('viewer HTTP lifecycle, all bytes gated, origin/schema and authority separation', async()=>{
 const f=fixture(); let p:Awaited<ReturnType<typeof launch>>|undefined;
 const password=randomBytes(24).toString('hex'), replacement=randomBytes(24).toString('hex');
 try {
 const members=[['style.css','text/css','body{color:red}'],['data.json','application/json','{"private":true}'],['print.html','text/html','<p>Private print</p>']];
 for(const [path,mediaType,content] of members){writeFileSync(join(f.bundle,path),content);f.manifest.members.push({path,mediaType,bytes:Buffer.byteLength(content),sha256:hash(content),executableMode:0});}
 const raw=JSON.stringify(f.manifest);writeFileSync(join(f.bundle,'manifest.json'),raw);f.env.FOLDY_BUNDLE_DIGEST=hash(raw);
 p=await launch(f);const u=p.url;
 const claimed=await post(u+'/api/claim',{assertion:f.assertion});const owner={cookie:claimed.headers.get('set-cookie')!.split(';')[0],origin:u};
 const request=async(path:string,value:unknown,headers:Record<string,string>={origin:u})=>{const r=await post(u+path,value,headers);assert.equal(r.headers.get('cache-control'),'no-store');return r;};
 const configure=(value:unknown,headers=owner)=>request('/api/owner/viewer-access',value,headers);
 assert.equal((await fetch(u+'/')).status,200);
 assert.equal((await (await fetch(u+'/api/viewer-access')).json()).mode,'public');
 assert.equal((await configure({mode:'password_required',password},{...owner,origin:'https://evil.invalid'})).status,403);
 assert.equal((await configure({mode:'password_required',password,extra:true})).status,400);
 assert.equal((await configure({mode:'password_required',password})).status,200);
 const routes=['/','/index.html','/style.css','/data.json','/print.html','/exports/unknown','/unknown'];
 for(const path of routes) for(const method of ['GET','HEAD']){const r=await fetch(u+path,{method,headers:owner});assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.ok(!(await r.text()).includes('Immutable Foldy'));}
 const unlock=()=>request('/api/viewer/unlock',{password});
 assert.equal((await request('/api/viewer/unlock',{password},{})).status,403);
 assert.equal((await request('/api/viewer/unlock',{password:'x'.repeat(5000)})).status,400);
 const unlocked=await unlock();assert.equal(unlocked.status,200);const setCookie=unlocked.headers.get('set-cookie')!;for(const flag of ['Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(setCookie.includes(flag));
 const viewer={cookie:setCookie.split(';')[0],origin:u};assert.deepEqual(await unlocked.json(),{unlocked:true,role:'VIEWER'});
 assert.match(await (await fetch(u+'/',{headers:viewer})).text(),/Immutable Foldy/);
 for(const [path] of members)assert.equal((await fetch(u+'/'+path,{headers:viewer})).status,200);
 assert.equal((await configure({mode:'public',confirmDisable:true},viewer)).status,401);
 assert.equal((await request('/api/operations',{name:'get_file',arguments:{path:'index.html'}},viewer)).status,401);
 assert.equal((await request('/api/mcp-grants',{},viewer)).status,401);
 assert.equal((await request('/mcp',{},viewer)).status,401);
 const readiness=await (await fetch(u+'/api/readiness',{headers:owner})).text();assert.ok(!readiness.includes('Immutable Foldy'));
 const ownerRead=await request('/api/operations',{name:'get_file',arguments:{path:'index.html'}},owner);assert.equal(ownerRead.status,200);
 assert.equal((await request('/api/viewer/logout',{},viewer)).status,200);assert.equal((await fetch(u+'/',{headers:viewer})).status,401);
 const again=await unlock();const prior={cookie:again.headers.get('set-cookie')!.split(';')[0]};
 assert.equal((await configure({mode:'password_required',password:replacement})).status,200);assert.equal((await fetch(u+'/',{headers:prior})).status,401);assert.equal((await unlock()).status,401);
 const fresh=await request('/api/viewer/unlock',{password:replacement});assert.equal(fresh.status,200);const freshCookie={cookie:fresh.headers.get('set-cookie')!.split(';')[0]};
 const exit=once(p.child,'exit');p.child.kill();await exit;p=await launch(f);
 assert.equal((await fetch(p.url+'/')).status,401);assert.equal((await fetch(p.url+'/',{headers:freshCookie})).status,200);
 const newOwner={...owner,origin:p.url};assert.equal((await post(p.url+'/api/owner/viewer-access',{mode:'public',confirmDisable:true},newOwner)).status,200);assert.equal((await fetch(p.url+'/')).status,200);
 assert.equal((await post(p.url+'/api/owner/viewer-access',{mode:'password_required',password},newOwner)).status,200);assert.equal((await fetch(p.url+'/',{headers:freshCookie})).status,401);
 for(const secret of [password,replacement,f.assertion,setCookie.split(';')[0]])assert.ok(!p.logs().includes(secret));
 }finally{if(p){const exit=once(p.child,'exit');p.child.kill();await exit;}rmSync(f.root,{recursive:true,force:true});}
});

test('cache configuration fails closed and forwarded sources cannot evade ingress',async()=>{
 const f=fixture();f.env.FOLDY_EXTERNAL_CACHE_ENABLED='1';let p:Awaited<ReturnType<typeof launch>>|undefined;
 try{p=await launch(f);const u=p.url;const claimed=await post(u+'/api/claim',{assertion:f.assertion});const owner={cookie:claimed.headers.get('set-cookie')!.split(';')[0],origin:u};
 const r=await post(u+'/api/owner/viewer-access',{mode:'password_required',password:randomBytes(24).toString('hex')},owner);assert.equal(r.status,400);assert.equal((await r.json()).code,'CACHE_UNAVAILABLE');
 assert.equal((await fetch(u+'/')).status,401);assert.equal((await (await fetch(u+'/api/viewer-access')).json()).mode,'unavailable');
 for(let i=0;i<21;i++){const response=await post(u+'/api/viewer/unlock',{password:randomBytes(24).toString('hex')},{origin:u,'x-forwarded-for':`192.0.2.${i}`,forwarded:`for=192.0.2.${i}`});assert.equal(response.status,i<20?503:429);assert.equal(response.headers.get('cache-control'),'no-store');}
 }finally{if(p){const exit=once(p.child,'exit');p.child.kill();await exit;}rmSync(f.root,{recursive:true,force:true});}
});

test('bounded ingress uses finite buckets and expiring budgets',async()=>{
 const {sourceLimiter}=await import('../dist/viewer-http.js');let now=0;const allow=sourceLimiter(()=>now,2,2);
 assert.equal(await allow('source-a'),true);assert.equal(await allow('source-a'),true);assert.equal(await allow('source-a'),false);
 assert.equal(await allow('source-b'),true);assert.equal(await allow('source-c'),false);now=60001;assert.equal(await allow('source-c'),true);
});

test('restored content stays sealed through claim and restart until explicit access choice',async()=>{
 const {Domain}=await import('../dist/domain.js');
 const {loadBundle}=await import('../dist/bundle.js');
 const f=fixture();let p:Awaited<ReturnType<typeof launch>>|undefined;
 const actor={id:'owner',owner:true,scopes:[]};
 const seed=loadBundle(f.bundle,f.env.FOLDY_BUNDLE_DIGEST);
 const source=new Domain(join(f.root,'source.sqlite'),seed);
 const backup=source.backup(actor);source.close();
 Domain.restore(join(f.root,'state','content.sqlite'),backup,actor,f.manifest);
 try{
  p=await launch(f);
  assert.equal((await fetch(p.url+'/')).status,423);
  const claimed=await post(p.url+'/api/claim',{assertion:f.assertion});
  const cookie=claimed.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await claimed.json()).state,'ACCESS_CONFIGURATION_REQUIRED');
  for(const path of ['/','/index.html'])assert.equal((await fetch(p.url+path)).status,423);
  assert.equal((await (await fetch(p.url+'/api/readiness',{headers:{cookie}})).json()).state,'ACCESS_CONFIGURATION_REQUIRED');
  const exited=once(p.child,'exit');p.child.kill();await exited;p=await launch(f);
  assert.equal((await fetch(p.url+'/')).status,423);
  const denied=await post(p.url+'/api/owner/viewer-access',{mode:'public',confirmDisable:true},{origin:p.url});
  assert.equal(denied.status,401);assert.equal((await fetch(p.url+'/')).status,423);
  const selected=await post(p.url+'/api/owner/viewer-access',{mode:'public',confirmDisable:true},{cookie,origin:p.url});
  assert.equal(selected.status,200);assert.equal((await fetch(p.url+'/')).status,200);
  assert.equal((await (await fetch(p.url+'/api/readiness',{headers:{cookie}})).json()).state,'READY');
 }finally{if(p){const exited=once(p.child,'exit');p.child.kill();await exited;}rmSync(f.root,{recursive:true,force:true});}
});
