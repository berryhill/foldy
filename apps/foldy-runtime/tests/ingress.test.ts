import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { ingressConfig } from '../dist/ingress.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const proxyOrigin = 'https://foldy.example:9443';
test('proxy admission is explicit, canonical and mutually exclusive with dev/TLS', () => {
 const base={FOLDY_PROXY_PUBLIC_ORIGIN:proxyOrigin};
 assert.deepEqual(ingressConfig(base),{mode:'proxy',origin:proxyOrigin,host:'foldy.example:9443',bind:'127.0.0.1'});
 for(const origin of ['http://foldy.example','https://foldy.example/','https://foldy.example/path','https://foldy.example?q=1','https://u@foldy.example','https://foldy.example#x','https://foldy.example:443','https://127.0.0.1','https://localhost','https://foldy.example:99999','https://FOLDY.example','https://foldy.example.']) assert.throws(()=>ingressConfig({...base,FOLDY_PROXY_PUBLIC_ORIGIN:origin}),origin);
 for(const extra of [{FOLDY_DEV_LOOPBACK:'1'},{FOLDY_TLS_KEY_FILE:'/key'},{FOLDY_TLS_CERT_FILE:'/cert'},{FOLDY_PUBLIC_HOST:'other.example'}]) assert.throws(()=>ingressConfig({...base,...extra}));
 assert.deepEqual(ingressConfig({FOLDY_DEV_LOOPBACK:'1'}),{mode:'dev',bind:'127.0.0.1'});
 assert.equal(ingressConfig({FOLDY_DEV_LOOPBACK:'0',FOLDY_PUBLIC_HOST:'127.0.0.1:9443',FOLDY_TLS_KEY_FILE:'/key',FOLDY_TLS_CERT_FILE:'/cert'}).mode,'direct');
 assert.throws(()=>ingressConfig({FOLDY_DEV_LOOPBACK:'1',FOLDY_PUBLIC_HOST:'foldy.example'}));
 assert.deepEqual(ingressConfig({FOLDY_PUBLIC_HOST:'foldy.example',FOLDY_TLS_KEY_FILE:'/key',FOLDY_TLS_CERT_FILE:'/cert'}),{mode:'direct',origin:'https://foldy.example',host:'foldy.example',bind:'0.0.0.0'});
});

test('proxy loopback transport publishes HTTPS identity but rejects rival Host/Origin and keeps authority distinct', async () => {
 const root=mkdtempSync(join(tmpdir(),'foldy-ingress-')),bundle=join(root,'bundle'),state=join(root,'state');mkdirSync(bundle);mkdirSync(state,{mode:0o700});
 const html='<!doctype html><h1>Ingress fixture</h1>',assertion=randomBytes(32).toString('hex');writeFileSync(join(bundle,'index.html'),html);
 const manifest=JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'ingress-1',projectId:'project-1',workbookId:'workbook-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]});
 writeFileSync(join(bundle,'manifest.json'),manifest);writeFileSync(join(root,'bootstrap.json'),JSON.stringify({instanceId:'ingress-1',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 const child=spawn(process.execPath,[resolve('dist/main.js')],{env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(manifest),FOLDY_STATE_DIR:state,FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_PROXY_PUBLIC_ORIGIN:proxyOrigin,FOLDY_PORT:'0',FOLDY_DEV_LOOPBACK:'',FOLDY_PUBLIC_HOST:'',FOLDY_TLS_KEY_FILE:'',FOLDY_TLS_CERT_FILE:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 try {
  for(let i=0;i<100&&!logs.match(/FOLDY_LISTENING (\d+)/);i++)await new Promise(r=>setTimeout(r,20));
  const port=logs.match(/FOLDY_LISTENING (\d+)/)?.[1];assert.ok(port,'proxy runtime starts');const url=`http://127.0.0.1:${port}`;
  const wire=(path:string,method:string,headers:Record<string,string>,body?:string)=>new Promise<Response>((done,reject)=>{
   const r=request(url+path,{method,headers:{host:'foldy.example:9443',...headers}},res=>{
    const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>done(new Response(Buffer.concat(chunks),{status:res.statusCode!,headers:res.headers as Record<string,string>})));
   });r.on('error',reject);r.end(body);
  });
  const get=(path:string,headers:Record<string,string>={})=>wire(path,'GET',headers);
  const post=(path:string,body:unknown,headers:Record<string,string>={})=>wire(path,'POST',{origin:proxyOrigin,'content-type':'application/json',...headers},JSON.stringify(body));
  const health=await get('/api/health');assert.equal(health.status,200,await health.text());
  for(const host of ['evil.example','foldy.example','FOLDY.example:9443','127.0.0.1:'+port]) assert.equal((await get('/api/health',{host})).status,403);
  for(const origin of ['http://foldy.example:9443','https://evil.example','null']) assert.equal((await get('/api/health',{origin})).status,403);
  assert.equal((await get('/api/health',{'x-forwarded-host':'evil.example','x-forwarded-proto':'http'})).status,200);
  const authz=await (await get('/.well-known/oauth-authorization-server')).json();assert.equal(authz.issuer,proxyOrigin);assert.equal(authz.authorization_endpoint,proxyOrigin+'/oauth/authorize');
  const resource=await (await get('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(resource.resource,proxyOrigin+'/mcp');
  const challenge=await get('/mcp');assert.equal(challenge.status,423);
  const claim=await post('/api/claim',{assertion,password:randomBytes(24).toString('hex')});assert.equal(claim.status,200);assert.match(claim.headers.get('set-cookie')!,/Secure/);
  const cookie=claim.headers.get('set-cookie')!.split(';')[0];assert.equal((await get('/api/readiness')).status,401);
  assert.equal((await get('/api/readiness',{cookie})).status,200);
  assert.equal((await post('/api/owner/logout',{}, {cookie,origin:'http://foldy.example:9443'})).status,403);
  const denied=await get('/mcp');assert.equal(denied.status,401);assert.equal(denied.headers.get('www-authenticate'),`Bearer resource_metadata="${proxyOrigin}/.well-known/oauth-protected-resource/mcp"`);
  const registration=await post('/oauth/register',{redirect_uris:['https://client.example/callback']});assert.equal(registration.status,201);
  const client=await registration.json();const authorize=await get('/oauth/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.example/callback',response_type:'code',resource:proxyOrigin+'/mcp',code_challenge:'a'.repeat(43),code_challenge_method:'S256'}),{cookie});assert.equal(authorize.status,200);
  assert.ok(!logs.includes(assertion));
 } finally {const exit=once(child,'exit');child.kill();await exit;rmSync(root,{recursive:true,force:true});}
});
