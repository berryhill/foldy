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
test('public owner shell, trusted script, sealed and authenticated gates',async()=>{
 const f=fixture();let p:Awaited<ReturnType<typeof launch>>|undefined;
 try{p=await launch(f);const u=p.url;
 for(const path of ['/owner','/unlock']){const r=await fetch(u+path);assert.equal(r.status,200);const html=await r.text();assert.ok(!html.includes('Immutable Foldy'));assert.ok(!html.includes(f.assertion));assert.match(html,/role="status"/);const csp=r.headers.get('content-security-policy')!;assert.match(csp,/script-src 'nonce-/);assert.ok(!csp.includes("'unsafe-inline'"));assert.equal(r.headers.get('cache-control'),'no-store');}
 const script=await fetch(u+'/owner/app.js');assert.equal(script.status,200);const source=await script.text();new Function(source);assert.ok(!source.includes('innerHTML'));assert.ok(!source.includes('localStorage'));assert.match(source,/textContent/);assert.match(source,/expectedUpdateRevisionId/);
 assert.equal((await fetch(u+'/')).status,423);assert.equal((await post(u+'/api/operations',{name:'list_updates',arguments:{}})).status,423);
 const claimed=await post(u+'/api/claim',{assertion:f.assertion});assert.equal(claimed.status,200);const cookie=claimed.headers.get('set-cookie')!;assert.match(cookie,/Secure; HttpOnly/);const owner={cookie:cookie.split(';')[0],origin:u};
 assert.equal((await post(u+'/api/claim',{assertion:f.assertion})).status,409);
 assert.equal((await post(u+'/api/operations',{name:'list_updates',arguments:{}})).status,401);
 assert.equal((await post(u+'/api/operations',{name:'list_updates',arguments:{}},owner)).status,200);
 const content=await fetch(u+'/');assert.equal(content.status,200);assert.match(content.headers.get('content-security-policy')!,/sandbox/);assert.ok(!content.headers.get('content-security-policy')!.includes('nonce-'));assert.match(await content.text(),/Immutable Foldy/);
 assert.equal((await fetch(u+'/owner?assertion=not-accepted')).status,400);
 }finally{if(p){const exit=once(p.child,'exit');p.child.kill();await exit;}rmSync(f.root,{recursive:true,force:true});}
});
