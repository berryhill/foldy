import { DatabaseSync } from 'node:sqlite';
import { LifecycleCoordinator } from './lifecycle.js';
import { existsSync, mkdtempSync, linkSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest, safePath } from './bundle.js';
import { dependencyEvidence, type Actor } from './domain.js';
export type Identity={instanceId:string;projectId:string;workbookId:string;revisionId:string};
const version='foldy-domain-backup.v1', runtime='foldy-runtime-domain.v1';
const states=['Draft','Ready for review','Changes requested','Approved','Published','Closed'];
const operations=['refresh_update_proposal','create_page','remove_page','move_page','create_update','update_page','save_update_revision','submit_update_for_review','add_review_comment','resolve_review_comment','request_update_changes','close_update','approve_update_revision','publish_update'];
function check(ok:unknown):asserts ok {if(!ok)throw Error('BACKUP_INVALID');}
function object(v:any,required:string[],optional:string[]=[]){check(v&&typeof v==='object'&&!Array.isArray(v));check(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>[...required,...optional].includes(k)));}
function text(v:any,max=2048){check(typeof v==='string'&&v.length>0&&v.length<=max);}
function id(v:any){check(typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v));}
function list(v:any){check(Array.isArray(v)&&v.length<=10000);}
function owner(a:Actor){if(!a?.owner)throw Error('OWNER_REQUIRED');}
/** Explicit allowlist: custody tables/meta never enter this format. User content is NOT secret-scanned.
 * BEGIN IMMEDIATE is the same SQLite write interlock used by publication/draft writes, including
 * other connections/processes. No await/callback occurs while locked; SQLITE_BUSY fails closed.
 * Delete/upgrade must acquire this same interlock and quiesce connections before file removal.
 */
export function exportBackup(db:DatabaseSync,actor:Actor):string{
 owner(actor);db.exec('BEGIN IMMEDIATE');try{
 LifecycleCoordinator.assertIdle(db);
 const ids=JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get('identity')!.value as string);
 const identity=Object.fromEntries(['instanceId','projectId','workbookId','revisionId'].map((k,i)=>[k,ids[i]]));
 const revisions=db.prepare('SELECT id,files,parent,actor FROM revisions ORDER BY id').all().map(r=>({...r,files:Object.fromEntries(Object.entries(JSON.parse(r.files as string)).map(([p,f]:[string,any])=>[p,{...f,sha256:digest(Buffer.from(f.content,'base64'))}]))}));
 const payload={identity,current:db.prepare('SELECT value FROM meta WHERE key=?').get('current')!.value,revisions,updates:db.prepare('SELECT value FROM updates ORDER BY id').all().map(r=>JSON.parse(r.value as string)),receipts:db.prepare('SELECT rowid AS sequence,key,input,value FROM receipts ORDER BY rowid').all().map(r=>({...r,value:JSON.parse(r.value as string)}))};
 const result=JSON.stringify({schemaVersion:version,runtimeCompatibility:runtime,payload,sha256:digest(JSON.stringify(payload))});validate(result,identity as Identity);db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function validate(raw:string,expected:Identity):any{
 check(typeof raw==='string'&&Buffer.byteLength(raw)<=64*1024*1024);const e=JSON.parse(raw);object(e,['schemaVersion','runtimeCompatibility','payload','sha256']);check(e.schemaVersion===version&&e.runtimeCompatibility===runtime&&e.sha256===digest(JSON.stringify(e.payload)));
 const p=e.payload;object(p,['identity','current','revisions','updates','receipts']);object(p.identity,['instanceId','projectId','workbookId','revisionId']);for(const k of Object.keys(p.identity) as (keyof Identity)[]){id(p.identity[k]);check(p.identity[k]===expected[k]);}
 list(p.revisions);list(p.updates);list(p.receipts);const rev=new Map<string,any>();
 for(const r of p.revisions){object(r,['id','parent','actor','files']);id(r.id);text(r.actor);check(!rev.has(r.id));rev.set(r.id,r);check(r.parent===null||typeof r.parent==='string');check(r.files&&typeof r.files==='object'&&!Array.isArray(r.files)&&Object.keys(r.files).length<=1024);check(Object.hasOwn(r.files,'index.html'));
 for(const [path,f]of Object.entries(r.files) as [string,any][]){check(safePath(path)&&!['__proto__','constructor','prototype'].includes(path));object(f,['content','mediaType','sha256']);check(typeof f.content==='string'&&f.content.length<=12*1024*1024);text(f.mediaType,128);const bytes=Buffer.from(f.content,'base64');check(bytes.toString('base64')===f.content&&digest(bytes)===f.sha256);}}
 check(rev.has(p.identity.revisionId)&&rev.has(p.current));check(rev.get(p.identity.revisionId).parent===null);
 const ancestor=(child:string,parent:string)=>{const seen=new Set<string>();while(child!==parent){check(!seen.has(child));seen.add(child);const r=rev.get(child);if(!r||r.parent===null)return false;child=r.parent;}return true;};
 for(const r of rev.values())check(ancestor(r.id,p.identity.revisionId));
 // A refresh retains the proposal's immutable parent chain. Its receipt witnesses
 // the changed publication base; do not require publication branches to be parents.
 const refreshes=new Map<string,any>();
 for(const {value:v} of p.receipts){if(v?.operation==='refresh_update_proposal'){
 object(v.refreshEvidence,['previousBaseRevisionId','previousUpdateRevisionId']);
 const f=v.refreshEvidence;check(rev.has(v.updateRevisionId)&&rev.has(f.previousBaseRevisionId)&&rev.has(f.previousUpdateRevisionId)&&rev.has(v.currentPublishedRevisionId));
 check(rev.get(v.updateRevisionId).parent===f.previousUpdateRevisionId&&!refreshes.has(v.updateRevisionId));refreshes.set(v.updateRevisionId,v);
 }else check(v?.refreshEvidence===undefined);}
 const initialBase=(u:any)=>{const rows=p.receipts.filter((r:any)=>r.value?.updateId===u.id&&r.value.operation==='create_update');check(rows.length===1);const v=rows[0].value;check(rev.has(v.updateRevisionId)&&rev.get(v.updateRevisionId).parent===v.currentPublishedRevisionId&&ancestor(u.revision,v.updateRevisionId));return v.currentPublishedRevisionId;};
 const baseAt=(u:any,revision:string):string=>{let cursor=revision;while(cursor!==null){const f=refreshes.get(cursor);if(f){check(f.updateId===u.id);return f.currentPublishedRevisionId;}cursor=rev.get(cursor)?.parent;}return initialBase(u);};
 const updates=new Map<string,any>(),comments=new Set<string>();
 for(const u of p.updates){object(u,['id','title','base','revision','state','comments'],['approval']);id(u.id);text(u.title);check(!updates.has(u.id));updates.set(u.id,u);check(rev.has(u.base)&&rev.has(u.revision)&&u.base!==u.revision&&baseAt(u,u.revision)===u.base&&ancestor(u.revision,initialBase(u)));check(states.includes(u.state));list(u.comments);
 if(u.approval!==undefined)check(rev.has(u.approval)&&ancestor(u.revision,u.approval)&&ancestor(u.approval,initialBase(u)));
 for(const c of u.comments){object(c,['id','text','blocking','resolved','target','revision','actor']);id(c.id);check(!comments.has(c.id));comments.add(c.id);text(c.text);text(c.actor);check(typeof c.blocking==='boolean'&&typeof c.resolved==='boolean'&&rev.has(c.revision)&&ancestor(u.revision,c.revision)&&ancestor(c.revision,initialBase(u)));object(c.target,[],['path','block','field','selection']);for(const v of Object.values(c.target))check(typeof v==='string'&&v.length<=2048);if(c.target.path)check(safePath(c.target.path)&&Object.hasOwn(rev.get(c.revision).files,c.target.path));}
 if(['Approved','Published'].includes(u.state))check(u.approval===u.revision&&!u.comments.some((c:any)=>c.blocking&&!c.resolved));
 }
 const keys=new Set<string>(),receipts=new Set<string>();
 // Receipt array order is transaction order, not idempotency-key or wall-clock order.
 // New exports bind that order explicitly; legacy backups retain their available order.
 const sequenced=p.receipts.some((r:any)=>r.sequence!==undefined);
 for(const [index,r] of p.receipts.entries()){object(r,['key','input','value'],['sequence']);if(sequenced)check(Number.isSafeInteger(r.sequence)&&r.sequence===index+1);text(r.key,4096);check(!keys.has(r.key)&&/^[a-f0-9]{64}$/.test(r.input));keys.add(r.key);const v=r.value;object(v,['projectId','updateId','priorState','currentState','updateRevisionId','currentPublishedRevisionId','receiptId','occurredAt','actorRef','operation','reason'],['commentId','checksEvidence','refreshEvidence']);if(v.checksEvidence!==undefined){check(rev.has(v.updateRevisionId));check(JSON.stringify(v.checksEvidence)===JSON.stringify(dependencyEvidence(rev.get(v.updateRevisionId).files,v.updateRevisionId)));check(v.checksEvidence.pass===true&&['submit_update_for_review','approve_update_revision','publish_update'].includes(v.operation));}check(v.projectId===p.identity.projectId&&updates.has(v.updateId)&&rev.has(v.updateRevisionId)&&rev.has(v.currentPublishedRevisionId));check(ancestor(updates.get(v.updateId).revision,v.updateRevisionId));id(v.receiptId);check(!receipts.has(v.receiptId));receipts.add(v.receiptId);text(v.actorRef);text(v.occurredAt);check(Number.isFinite(Date.parse(v.occurredAt)));check(operations.includes(v.operation)&&states.includes(v.currentState)&&(v.priorState===null||states.includes(v.priorState)));if(v.reason!==null)text(v.reason);if(v.commentId!==undefined)check(updates.get(v.updateId).comments.some((c:any)=>c.id===v.commentId));}
 // Domain mutations persist state and receipts atomically. Require witnesses for the
 // stored state and retained approval, not a reconstructed/imported root history.
 const byUpdate=new Map<string,any[]>();
 for(const {value:v} of p.receipts){
 const u=updates.get(v.updateId);const prior=v.priorState;
 if(v.operation!=='close_update')check(v.currentPublishedRevisionId===(v.operation==='publish_update'?v.updateRevisionId:baseAt(u,v.updateRevisionId)));
 if(v.operation==='create_update')check(prior===null&&v.currentState==='Draft');
 else check(prior!==null&&!['Closed','Published'].includes(prior));
 switch(v.operation){
 case 'refresh_update_proposal':{
 const f=v.refreshEvidence;check(v.currentState==='Draft'&&baseAt(u,f.previousUpdateRevisionId)===f.previousBaseRevisionId&&f.previousBaseRevisionId!==v.currentPublishedRevisionId);
 const before=rev.get(f.previousBaseRevisionId).files,proposal=rev.get(f.previousUpdateRevisionId).files,published=rev.get(v.currentPublishedRevisionId).files,merged={...published};
 const equal=(a:any,b:any)=>a?.content===b?.content&&a?.mediaType===b?.mediaType;
 for(const path of new Set([...Object.keys(before),...Object.keys(proposal),...Object.keys(published)])){if(equal(before[path],proposal[path]))continue;check(equal(before[path],published[path])||equal(proposal[path],published[path]));if(proposal[path])merged[path]=proposal[path];else delete merged[path];}
 const actual=rev.get(v.updateRevisionId).files;check(Object.keys(actual).length===Object.keys(merged).length&&Object.keys(merged).every(path=>equal(actual[path],merged[path])));break;
 }
 case 'create_page':case 'remove_page':case 'move_page':case 'update_page':case 'save_update_revision':check(v.currentState==='Draft');break;
 case 'submit_update_for_review':check(['Draft','Changes requested'].includes(prior)&&v.currentState==='Ready for review');break;
 case 'approve_update_revision':check(['Ready for review','Changes requested'].includes(prior)&&v.currentState==='Approved');break;
 case 'publish_update':check(prior==='Approved'&&v.currentState==='Published'&&u.state==='Published'&&u.revision===v.updateRevisionId);break;
 case 'request_update_changes':check(v.currentState==='Changes requested');break;
 case 'close_update':check(v.currentState==='Closed');break;
 case 'resolve_review_comment':check(v.currentState===prior);break;
 case 'add_review_comment':{const c=u.comments.find((c:any)=>c.id===v.commentId);check(c&&c.revision===v.updateRevisionId&&v.currentState===(c.blocking?'Changes requested':prior));break;}
 }
 const rows=byUpdate.get(u.id)||[];rows.push(v);byUpdate.set(u.id,rows);
 }
 for(const u of updates.values()){
 const rows=byUpdate.get(u.id)||[];
 check(rows.some(v=>v.updateRevisionId===u.revision&&v.currentState===u.state));
 // Material edits intentionally retain stale approval pointers to older revisions.
 if(u.approval!==undefined)check(rows.some(v=>v.operation==='approve_update_revision'&&v.updateRevisionId===u.approval));
 if(u.state==='Published')check(rows.some(v=>v.operation==='publish_update'&&v.updateRevisionId===u.revision));
 }
 const published=p.updates.filter((u:any)=>u.state==='Published');let current=p.identity.revisionId;const visited=new Set<string>();while(current!==p.current){check(!visited.has(current));visited.add(current);const next=published.filter((u:any)=>u.base===current);check(next.length===1);current=next[0].revision;}check(published.every((u:any)=>visited.has(u.base)));
 const publicationOrder=new Map<string,number>([...visited,p.current].map((r,i)=>[r,i]));
 // Abandonment may observe a newer publication, but never an unpublished proposal or a base regression.
 for(const {value:v}of p.receipts){if(v.operation==='close_update'){const base=publicationOrder.get(baseAt(updates.get(v.updateId),v.updateRevisionId)),observed=publicationOrder.get(v.currentPublishedRevisionId);check(base!==undefined&&observed!==undefined&&observed>=base);}}
 for(const v of refreshes.values()){const old=publicationOrder.get(v.refreshEvidence.previousBaseRevisionId),next=publicationOrder.get(v.currentPublishedRevisionId);check(old!==undefined&&next!==undefined&&next>old);}
 return p;
}
/** Local trusted control-plane API, not a public bootstrap endpoint. Authorization must be supplied
 * by an authenticated owner/recovery reset. No auth rows are created. Caller MUST hold traffic
 * SEALED until fresh bootstrap AND explicit viewer-access configuration; never auto-open restored data.
 * Stage privately; commit/check integrity; hard-link atomically with no overwrite. Invalid input
 * never creates the target. A target racing activation causes failure, never replacement.
 */
export function restoreBackup(target:string,raw:string,actor:Actor,expected:Identity){
 owner(actor);const p=validate(raw,expected);if(existsSync(target))throw Error('TARGET_EXISTS');const dir=mkdtempSync(join(dirname(target),'.foldy-restore-'));let db:DatabaseSync|undefined;
 try{const stage=join(dir,'content.sqlite');db=new DatabaseSync(stage);chmodSync(stage,0o600);db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE revisions(id TEXT PRIMARY KEY,files TEXT NOT NULL,parent TEXT,actor TEXT NOT NULL); CREATE TABLE updates(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE receipts(key TEXT PRIMARY KEY,input TEXT NOT NULL,value TEXT NOT NULL);');
 LifecycleCoordinator.assertIdle(db);
 db.prepare('INSERT INTO meta VALUES(?,?)').run('identity',JSON.stringify([p.identity.instanceId,p.identity.projectId,p.identity.workbookId,p.identity.revisionId]));db.prepare('INSERT INTO meta VALUES(?,?)').run('current',p.current);db.prepare('INSERT INTO meta VALUES(?,?)').run('recovery_access_required','1');
 for(const r of p.revisions){const files=Object.fromEntries(Object.entries(r.files).map(([path,f]:[string,any])=>[path,{content:f.content,mediaType:f.mediaType}]));db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(r.id,JSON.stringify(files),r.parent,r.actor);}
 for(const u of p.updates)db.prepare('INSERT INTO updates VALUES(?,?)').run(u.id,JSON.stringify(u));for(const r of p.receipts)db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(r.key,r.input,JSON.stringify(r.value));db.exec('COMMIT');check(db.prepare('PRAGMA integrity_check').get()!.integrity_check==='ok');db.close();db=undefined;linkSync(stage,target);
 return {identity:p.identity as Identity,currentRevisionId:p.current as string,state:'SEALED' as const,requiresFreshBootstrap:true as const,requiresViewerAccessConfiguration:true as const};
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
}
