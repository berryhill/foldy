import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export async function startFoldy(backup?: string) {
 const root = mkdtempSync(join(tmpdir(), 'foldy-browser-'));
 const bundle = join(root, 'bundle'); mkdirSync(bundle);
 if (backup === undefined) mkdirSync(join(root, 'state'),{mode:0o700});
 const html = '<!doctype html><h1>Immutable Foldy</h1>';
 writeFileSync(join(bundle, 'index.html'), html);
 const raw = JSON.stringify({schemaVersion:'foldy-release-bundle.v1',instanceId:'instance-1',projectId:'project-1',workbookId:'workbook-1',revisionId:'revision-1',runtimeImageDigest:`sha256:${'a'.repeat(64)}`,members:[{path:'index.html',mediaType:'text/html',bytes:Buffer.byteLength(html),sha256:hash(html),executableMode:0}]});
 writeFileSync(join(bundle, 'manifest.json'), raw);
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
