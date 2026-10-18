import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export async function startFoldy(backup?: string, preservedCopy=false, documentAssets=false) {
 const root = mkdtempSync(join(tmpdir(), 'foldy-browser-'));
 let bundle = join(root, 'bundle'); mkdirSync(bundle);
 if (backup === undefined) mkdirSync(join(root, 'state'),{mode:0o700});
 const html = documentAssets ? '<!doctype html><link rel="stylesheet" href="theme.css"><h1>Immutable Foldy</h1><a href="nested/page.html">Next page</a>' : '<!doctype html><h1>Immutable Foldy</h1>';
 const documents:Record<string,string>={'index.html':html,...(documentAssets?{'theme.css':'h1{color:rgb(12,34,56)}','nested/page.html':'<!doctype html><link rel="stylesheet" href="../theme.css"><h1>Nested page</h1><a href="../index.html">Back</a>'}:{})};
 const members=Object.entries(documents).map(([path,content])=>{mkdirSync(join(bundle,path,'..'),{recursive:true});writeFileSync(join(bundle,path),content);return {path,mediaType:path.endsWith('.css')?'text/css':'text/html',bytes:Buffer.byteLength(content),sha256:hash(content),executableMode:0};});
 let raw = JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'workbook-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members});
 writeFileSync(join(bundle, 'manifest.json'), raw);
 if(preservedCopy){
  if(backup!==undefined||documentAssets)throw Error('Unsupported combined fixture');
  const source=join(root,'reviewed-source');mkdirSync(source);writeFileSync(join(source,'index.html'),html);
  const {schemaVersion,...revision}=JSON.parse(raw);
  const plan=join(root,'migration-plan.json');writeFileSync(plan,JSON.stringify({schemaVersion:'foldy-preserved-copy-plan.v1',sourceProjectUrl:'https://original.example/projects/project-1',provenance:'Synthetic owner-reviewed immutable export for browser regression only',revision:{...revision,approvedRevisionId:'revision-1',frozen:true,runtimeVersion:'0.1.0'}}));
  bundle=join(root,'migrated-bundle');
  const report=JSON.parse(execFileSync(process.execPath,[resolve('../apps/foldy-runtime/dist/migrate.js'),'--source-dir',source,'--plan-file',plan,'--output-dir',bundle],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  if(!report.ok)throw Error('Migration fixture failed');raw=readFileSync(join(bundle,'manifest.json'),'utf8');
 }
 if (backup !== undefined) {
  const custody=join(root,'custody');mkdirSync(custody,{mode:0o700});
  const backupFile=join(root,'backup.json'),authorizationFile=join(custody,'authorization.json'),target=join(root,'state');
  writeFileSync(backupFile,backup,{mode:0o600});
  writeFileSync(authorizationFile,JSON.stringify({schemaVersion:'foldy-restore-authorization.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'workbook-1',bundleDigest:hash(raw),backupDigest:hash(backup),expiresAt:Date.now()+600000,nonce:randomBytes(32).toString('hex'),custodyDirectory:custody,targetDirectory:target}),{mode:0o600});
  try {
   const restored=JSON.parse(execFileSync(process.execPath,[resolve('../apps/foldy-runtime/dist/restore-cli.js'),'--backup-file',backupFile,'--bundle-dir',bundle,'--bundle-digest',hash(raw),'--authorization-file',authorizationFile,'--target-dir',target,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
   if(restored.state!=='SEALED')throw Error('Restore did not return SEALED');
  } catch {rmSync(root,{recursive:true,force:true});throw Error('Offline restore CLI failed');}
 }
 const assertion = randomBytes(32).toString('hex');
 writeFileSync(join(root,'bootstrap.json'), JSON.stringify({instanceId:'instance-1',verifier:hash(assertion),expiresAt:Date.now()+600000}),{mode:0o600});
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const address=reserve.address();if(!address||typeof address==='string')throw Error('Port unavailable');const port=address.port;await new Promise<void>(r=>reserve.close(()=>r()));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
 const child = spawn(process.execPath,[resolve('../apps/foldy-runtime/dist/main.js')],{env:{...process.env,FOLDY_BUNDLE_DIR:bundle,FOLDY_BUNDLE_DIGEST:hash(raw),FOLDY_STATE_DIR:join(root,'state'),FOLDY_BOOTSTRAP_FILE:join(root,'bootstrap.json'),FOLDY_DEV_LOOPBACK:'0',FOLDY_PUBLIC_HOST:`127.0.0.1:${port}`,FOLDY_TLS_KEY_FILE:join(root,'key.pem'),FOLDY_TLS_CERT_FILE:join(root,'cert.pem'),FOLDY_PORT:String(port),FOLDY_EXTERNAL_CACHE_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 let logs=''; child.stderr.on('data',c=>{logs+=c;});
 const close = async (preserve = false) => { if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;} if(!preserve)rmSync(root,{recursive:true,force:true}); };
 try {
 const port = await new Promise<string>((resolvePort,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Runtime readiness deadline')),10000);
  child.once('exit',()=>{clearTimeout(timeout);reject(Error('Runtime exited before readiness'));});
  child.once('error',reject);
  child.stdout.on('data',c=>{logs+=c;const match=logs.match(/FOLDY_LISTENING (\d+)/);if(match?.[1]){clearTimeout(timeout);resolvePort(match[1]);}});
 });
 return {url:`https://127.0.0.1:${port}`,assertion,root,close};
 } catch(error) {await close();throw error;}
}
