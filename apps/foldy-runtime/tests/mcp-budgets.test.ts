import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
async function fixture(run:(f:{url:string;owner:Record<string,string>;advance:(ms:number)=>void})=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),'foldy-mcp-budgets-')),bundle=join(root,'bundle'),state=join(root,'state'),clock=join(root,'clock');
 mkdirSync(bundle);mkdirSync(state,{mode:0o700});writeFileSync(clock,'0');
 const html='<h1>Budget fixture</h1>';writeFileSync(join(bundle,'index.html'),html);
 const manifest=JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'budget-instance',projectId:'budget-project',workbookId:'budget-workbook',revisionId:'revision-1',runtimeImageDigest:'sha256:'+'a'.repeat(64),members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]});
 writeFileSync(join(bundle,'manifest.json'),manifest);const assertion=randomBytes(32).toString('hex');
 writeFileSync(join(root,'bootstrap.json'),JSON.stringify({instanceId:'budget-instance',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 // Test-process clock injection only; production runtime has no clock override.
 const preload='import {readFileSync} from "node:fs";const real=Date.now;Date.now=()=>real()+Number(readFileSync(process.env.FOLDY_TEST_CLOCK_FILE,"utf8"));';
 const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),resolve('dist/main.js')],{env:{...process.env,FOLDY_TEST_CLOCK_FILE:clock,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(manifest),FOLDY_STATE_DIR:state,FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_DEV_LOOPBACK:'1',FOLDY_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',v=>logs+=v);child.stderr.on('data',()=>{});
 try{
  for(let i=0;i<200&&!logs.match(/FOLDY_LISTENING (\d+)/)&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,10));
  const port=logs.match(/FOLDY_LISTENING (\d+)/)?.[1];assert.ok(port,'fixture starts');const url='http://127.0.0.1:'+port;
  const claim=await post(url+'/api/claim',{assertion,password:randomBytes(24).toString('hex')});assert.equal(claim.status,200);
  const owner={cookie:claim.headers.get('set-cookie')!.split(';')[0],origin:url};
  await run({url,owner,advance:ms=>writeFileSync(clock,String(ms))});
 }finally{if(child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}rmSync(root,{recursive:true,force:true});}
}
const post=(url:string,body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const init=(url:string,token:string)=>post(url+'/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'budget-test',version:'1'}}},{authorization:'Bearer '+token,accept:'application/json, text/event-stream'});
test('per-grant and instance request limits expire, while revocation remains available',()=>fixture(async f=>{
 const grants=[];for(let i=0;i<10;i++){const r=await post(f.url+'/api/mcp-grants',{},f.owner);assert.equal(r.status,201);grants.push(await r.json());}
 let accepted=0,limited=0;
 for(const grant of grants)for(let i=0;i<61;i++){
  const r=await fetch(f.url+'/mcp',{headers:{authorization:'Bearer '+grant.token}});
  if(r.status===400)accepted++;else{assert.equal(r.status,429);limited++;}
 }
 assert.equal(accepted,512);assert.ok(limited>0);
 f.advance(61000);assert.equal((await init(f.url,grants[0].token)).status,200);
 assert.equal((await post(f.url+'/api/mcp-grants/revoke-all',{},f.owner)).status,200);
 assert.equal((await init(f.url,grants[0].token)).status,401);
}));
test('instance session cap includes concurrent initialization; expired sessions reclaim capacity',()=>fixture(async f=>{
 const grants=[];for(let i=0;i<5;i++)grants.push(await(await post(f.url+'/api/mcp-grants',{},f.owner)).json());
 for(const grant of grants.slice(0,4)){
  const responses=await Promise.all(Array.from({length:10},()=>init(f.url,grant.token)));
  assert.equal(responses.filter(r=>r.status===200).length,8);assert.ok(responses.every(r=>[200,429].includes(r.status)));
 }
 assert.equal((await init(f.url,grants[4].token)).status,429);
 f.advance(3600001);
 assert.equal((await init(f.url,grants[0].token)).status,401);
 const fresh=await(await post(f.url+'/api/mcp-grants',{},f.owner)).json();
 assert.equal((await init(f.url,fresh.token)).status,200);
 assert.equal((await post(f.url+'/api/mcp-grants/revoke-all',{},f.owner)).status,200);
}));
