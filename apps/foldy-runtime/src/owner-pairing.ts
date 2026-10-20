import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OwnerAuthority, protectedAncestry } from './owner-authority.js';
import { activeBundle } from './upgrade.js';

const deny = (): never => { throw Error('PAIRING_DENIED'); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const codePattern = /^[a-f0-9]{64}$/;
const duration = 15 * 60000;
const capacity = 32;
type Pending = { schemaVersion: 'foldy-owner-pairing.v1'; instanceId: string; bundleDigest: string; generation: number; verifier: string; expiresAt: number };
type Base = { stateDirectory: string; bundleDigest: string; now?: () => number };
export type PairingCreation = Base & { instanceId: string };
export type PairingApproval = Base & { bundleDirectory: string; recoveryFile: string; requestId: string };
function absolute(path: string) { if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) deny(); }
function present(path: string) { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
function sync(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function save(path: string, bytes: string) {
 const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try { const st=fstatSync(fd); if (!st.isFile() || st.nlink!==1 || st.uid!==process.getuid?.() || (st.mode&0o077)) deny(); writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function read(path: string): Pending {
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try { const st=fstatSync(fd); if (!st.isFile() || st.nlink!==1 || st.uid!==process.getuid?.() || (st.mode&0o077) || st.size>2048) deny();
  const v=JSON.parse(readFileSync(fd,'utf8')) as Pending;
  if (!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).sort().join(',')!=='bundleDigest,expiresAt,generation,instanceId,schemaVersion,verifier' || v.schemaVersion!=='foldy-owner-pairing.v1' || typeof v.instanceId!=='string' || !v.instanceId || typeof v.bundleDigest!=='string' || !codePattern.test(v.verifier) || !Number.isSafeInteger(v.generation) || v.generation<1 || !Number.isSafeInteger(v.expiresAt)) deny();
  return v;
 } finally { closeSync(fd); }
}
function withPairingLock<T>(state: string, action: () => T): T {
 protectedAncestry(state,true);
 const lock=join(state,'owner-pairings.lock'); save(lock,'');
 try { return action(); } finally { unlinkSync(lock); sync(state); }
}
function directory(state: string) {
 const dir=join(state,'owner-pairings');
 if (!present(dir)) { mkdirSync(dir,{mode:0o700}); sync(state); }
 protectedAncestry(dir,true); return dir;
}
/** Runtime-only primitive: the caller sets the browser secret in a Secure HttpOnly cookie.
 * Never put the secret in a URL, response body, log, or persisted pairing row. */
export function createOwnerPairing(input: PairingCreation) {
 absolute(input.stateDirectory); protectedAncestry(input.stateDirectory,true);
 if (typeof input.instanceId!=='string' || !input.instanceId || typeof input.bundleDigest!=='string' || !input.bundleDigest) deny();
 return withPairingLock(input.stateDirectory,()=>{
  const authority=new OwnerAuthority({directory:input.stateDirectory,instanceId:input.instanceId,bundleDigest:input.bundleDigest});
  const state=authority.state, now=input.now?.()??Date.now();if (!state || !state.ownerPassword || !Number.isSafeInteger(now)) deny();
  const claimed=state!;
  const dir=directory(input.stateDirectory);
  // Fail closed on malformed entries. Never delete paths based on untrusted directory names.
  const entries=readdirSync(dir);
  for(const entry of entries) {
   if (!codePattern.test(entry.slice(0,-5)) || !entry.endsWith('.json')) deny();
   const path=join(dir,entry),row=read(path);
   if (row.instanceId!==claimed.instanceId || row.bundleDigest!==claimed.bundleDigest) deny();
   if (row.expiresAt<=now || row.generation!==claimed.generation) unlinkSync(path);
   else if (row.expiresAt>now+duration) deny();
  }
  if(readdirSync(dir).length>=capacity) deny();
  const requestId=randomBytes(32).toString('hex'),browserSecret=randomBytes(32).toString('base64url'),expiresAt=now+duration;
  const row:Pending={schemaVersion:'foldy-owner-pairing.v1',instanceId:claimed.instanceId,bundleDigest:claimed.bundleDigest,generation:claimed.generation,verifier:hash(browserSecret),expiresAt};
  save(join(dir,requestId+'.json'),JSON.stringify(row));sync(dir);
  return {requestId,browserSecret,expiresAt};
 });
}
/** Deploying-principal-only offline operation. An independent, supported operator
 * decision UI must confirm the exact request after recipient comparison. A requestId
 * is only a lookup, never a possession or verification factor. */
export function approveOwnerPairing(input: PairingApproval) {
 for (const p of [input.stateDirectory,input.bundleDirectory,input.recoveryFile]) absolute(p);
 if (typeof input.requestId!=='string' || !codePattern.test(input.requestId) || typeof input.bundleDigest!=='string') deny();
 if (input.recoveryFile===input.bundleDirectory || input.recoveryFile.startsWith(input.bundleDirectory+sep)) deny();
 protectedAncestry(input.stateDirectory,true);protectedAncestry(dirname(input.recoveryFile),true);
 const runtimeLock=join(input.stateDirectory,'runtime.lock');save(runtimeLock,'');
 try { return withPairingLock(input.stateDirectory,()=>{
  if (present(input.recoveryFile)) deny();
  const {bundle,authorityBundleDigest}=activeBundle(input.stateDirectory,{directory:input.bundleDirectory,digest:input.bundleDigest});
  const authority=new OwnerAuthority({directory:input.stateDirectory,instanceId:bundle.manifest.instanceId,bundleDigest:authorityBundleDigest});
  const state=authority.state,now=input.now?.()??Date.now();if (!state || !state.ownerPassword || !Number.isSafeInteger(now)) deny();
  const claimed=state!;
  const row=read(join(directory(input.stateDirectory),input.requestId+'.json'));
  if (row.instanceId!==claimed.instanceId || row.bundleDigest!==claimed.bundleDigest || row.generation!==claimed.generation || row.expiresAt<=now || row.expiresAt>now+duration) deny();
  const authorization={schemaVersion:'foldy-owner-recovery.v1',instanceId:claimed.instanceId,bundleDigest:claimed.bundleDigest,generation:claimed.generation,nonce:randomBytes(32).toString('hex'),verifier:row.verifier,expiresAt:row.expiresAt};
  save(input.recoveryFile,JSON.stringify(authorization));sync(dirname(input.recoveryFile));
  return {requestId:input.requestId,status:'approved' as const,expiresAt:row.expiresAt};
 }); } finally { unlinkSync(runtimeLock);sync(input.stateDirectory); }
}
export function ownerPairingCli(argv: string[]) {
 const flags=['--request-id','--state-dir','--bundle-dir','--bundle-digest','--recovery-file'],args=new Map<string,string>();
 for(let i=0;i<argv.length;i++){if(!flags.includes(argv[i])||args.has(argv[i])||!argv[i+1]||argv[i+1].startsWith('--'))deny();args.set(argv[i],argv[++i]);}
 if(args.size!==flags.length)deny();
 return approveOwnerPairing({requestId:args.get('--request-id')!,stateDirectory:args.get('--state-dir')!,bundleDirectory:args.get('--bundle-dir')!,bundleDigest:args.get('--bundle-digest')!,recoveryFile:args.get('--recovery-file')!});
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try { console.log(JSON.stringify(ownerPairingCli(process.argv.slice(2)))); } catch { console.error('PAIRING_DENIED');process.exitCode=1; }
}
