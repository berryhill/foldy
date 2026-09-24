import { constants, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, renameSync, unlinkSync, lstatSync, mkdirSync, fstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { loadBundle, digest } from './bundle.js';
import { Domain } from './domain.js';
import { protectedAncestry, OwnerAuthority } from './owner-authority.js';

type Release = { directory:string; digest:string };
export type Activation = { schemaVersion:'foldy-activation.v1'; generation:number; current:Release; previous:Release; authorityBundleDigest:string; snapshot:string; snapshotDigest:string; operationId:string };
const deny=():never=>{throw Error('UPGRADE_DENIED');};
function sync(dir:string){const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function save(path:string,bytes:string|Buffer){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function privateRead(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.nlink!==1||s.size>64*1024*1024)deny();return readFileSync(fd);}finally{closeSync(fd);}}
export function readActivation(stateDir:string):Activation|undefined {
 const path=join(stateDir,'runtime-activation.json');
 try{lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 protectedAncestry(stateDir,true);const a=JSON.parse(privateRead(path).toString()) as Activation;
 if(a.schemaVersion!=='foldy-activation.v1'||!Number.isSafeInteger(a.generation)||a.generation<1||!a.current||!a.previous||!a.authorityBundleDigest||!a.snapshot||!a.snapshotDigest||!a.operationId)deny();
 return a;
}
/** Called only after the shared runtime.lock has been acquired. No change to
 * content, custody, viewer policy or publication is permitted by activation. */
export function activeBundle(stateDir:string,initial:Release){const a=readActivation(stateDir);return {bundle:loadBundle(a?.current.directory??initial.directory,a?.current.digest??initial.digest),authorityBundleDigest:a?.authorityBundleDigest??initial.digest};}
export interface UpgradeRequest { stateDirectory:string; incumbent:Release; candidate:Release; expectedGeneration:number; operationId:string; confirmation:string; dataCompatibility:'foldy-runtime-domain.v1'; kind:'upgrade'|'rollback' }
/** Offline OS-owner control plane. Runtime and this operator command share the
 * exclusive lock. A crash strands the lock intentionally: never auto-break it.
 * v1 supports no migrations: candidate seed bytes/policy must be identical.
 * This selects the local release; it does NOT replace a provider container. */
export function executeUpgrade(r:UpgradeRequest):Activation {
 const state=resolve(r.stateDirectory);protectedAncestry(state,true);
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(r.operationId)||!['upgrade','rollback'].includes(r.kind)||r.dataCompatibility!=='foldy-runtime-domain.v1')deny();
 const lock=join(state,'runtime.lock');const fd=openSync(lock,'wx',0o600);closeSync(fd);
 try {
 const previous=readActivation(state);const generation=previous?.generation??0;
 const current=previous?.current??r.incumbent;
 if(generation!==r.expectedGeneration||current.digest!==r.incumbent.digest)deny();
 const old=loadBundle(current.directory,current.digest),candidate=loadBundle(r.candidate.directory,r.candidate.digest);
 if(r.confirmation!==old.manifest.instanceId)deny();
 for(const key of ['instanceId','projectId','workbookId','revisionId'] as const)if(old.manifest[key]!==candidate.manifest[key])deny();
 // Seed content and runtime policy cannot be replaced by an image upgrade.
 if(JSON.stringify(old.manifest.members)!==JSON.stringify(candidate.manifest.members)||JSON.stringify(old.protectedPaths)!==JSON.stringify(candidate.protectedPaths))deny();
 if(old.manifest.runtimeImageDigest===candidate.manifest.runtimeImageDigest)deny();
 if(r.kind==='rollback'&&(!previous||candidate.bundleDigest!==previous.previous.digest))deny();
 const authorityBundleDigest=previous?.authorityBundleDigest??old.bundleDigest;
 const authority=new OwnerAuthority({directory:state,instanceId:old.manifest.instanceId,bundleDigest:authorityBundleDigest});
 if(!authority.state)deny();
 // Validate custody and the existing schema/identity without initialization.
 const database=join(state,'content.sqlite');
 const dbfd=openSync(database,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
 const st=fstatSync(dbfd);if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.nlink!==1||st.size===0)deny();
 // The private, protected state directory and shared lock exclude cooperating
 // writers. Keep the nofollow descriptor open and verify inode identity as well.
 // Immutable read-only mode prevents SQLite from creating WAL/SHM files on
 // rejection. An offline upgrade requires a checkpointed database: never ignore
 // pending WAL or recovery journals, nor follow sidecar links outside custody.
 for(const suffix of ['-wal','-shm','-journal']){
 const sidecar=database+suffix;let present=true;
 try{lstatSync(sidecar);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')present=false;else throw error;}
 if(present){const bytes=privateRead(sidecar);if(suffix!=='-shm'&&bytes.length)deny();}
 }
 const uri=pathToFileURL(database);uri.search='immutable=1';
 const inspect=new DatabaseSync(uri.href,{readOnly:true});
 try{
 const now=lstatSync(database);if(now.isSymbolicLink()||now.dev!==st.dev||now.ino!==st.ino)deny();
 for(const [table,columns] of Object.entries({meta:['key','value'],revisions:['id','files','parent','actor'],updates:['id','value'],receipts:['key','input','value']})){
 if(inspect.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table)?.type!=='table')deny();
 const actual=inspect.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
 if(JSON.stringify(actual)!==JSON.stringify(columns))deny();
 }
 const identity=JSON.stringify([old.manifest.instanceId,old.manifest.projectId,old.manifest.workbookId,old.manifest.revisionId]);
 if(inspect.prepare('SELECT value FROM meta WHERE key=?').get('identity')?.value!==identity)deny();
 const current=inspect.prepare('SELECT value FROM meta WHERE key=?').get('current')?.value;
 if(typeof current!=='string'||!inspect.prepare('SELECT id FROM revisions WHERE id=?').get(current)||!inspect.prepare('SELECT id FROM revisions WHERE id=?').get(old.manifest.revisionId))deny();
 }finally{inspect.close();}
 }finally{closeSync(dbfd);}
 const domain=new Domain(database,old);let snapshot:string;
 try{snapshot=domain.backup({id:'offline-operator',owner:true,scopes:[]});}finally{domain.close();}
 if(r.kind==='rollback'&&(digest(privateRead(previous!.snapshot))!==previous!.snapshotDigest||digest(snapshot)!==previous!.snapshotDigest))throw Error('ROLLBACK_DATA_CHANGED');
 // Reopen with the real candidate verifier before activation, not a fake readiness callback.
 const verified=new Domain(database,candidate);try{if(verified.backup({id:'offline-operator',owner:true,scopes:[]})!==snapshot)deny();}finally{verified.close();}
 const root=join(state,'runtime-releases');mkdirSync(root,{recursive:true,mode:0o700});protectedAncestry(root,true);
 const stage=join(root,randomUUID());mkdirSync(stage,{mode:0o700});
 const directories=new Set<string>([stage]);
 for(const [path,file]of candidate.files){const parts=path.split('/');let dir=stage;for(const part of parts.slice(0,-1)){dir=join(dir,part);mkdirSync(dir,{recursive:true,mode:0o700});directories.add(dir);}save(join(stage,path),file.bytes);}
 save(join(stage,'manifest.json'),readFileSync(join(r.candidate.directory,'manifest.json')));
 for(const dir of [...directories].sort((a,b)=>b.split('/').length-a.split('/').length))sync(dir);
 sync(root);
 loadBundle(stage,candidate.bundleDigest);
 const snapshots=join(state,'runtime-snapshots');mkdirSync(snapshots,{recursive:true,mode:0o700});protectedAncestry(snapshots,true);
 const snapshotPath=join(snapshots,randomUUID()+'.json');save(snapshotPath,snapshot);sync(snapshots);sync(state);
 // One durable pointer is the commit point. Incumbent, custody and data remain untouched.
 const activation:Activation={schemaVersion:'foldy-activation.v1',generation:generation+1,current:{directory:stage,digest:candidate.bundleDigest},previous:current,authorityBundleDigest,snapshot:snapshotPath,snapshotDigest:digest(snapshot),operationId:r.operationId};
 const tmp=join(state,'.activation-'+randomUUID());save(tmp,JSON.stringify(activation));renameSync(tmp,join(state,'runtime-activation.json'));sync(state);
 return readActivation(state)!;
 }finally{unlinkSync(lock);sync(state);}
}