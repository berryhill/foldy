import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Domain } from '../dist/domain.js';
import { digest } from '../dist/bundle.js';
const owner={id:'owner',owner:true,scopes:[]};
test('restored access gate survives reopen, requires owner, and is never exported',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-gate-'));let d=new Domain(join(dir,'source'),seed);
 try{assert.equal(d.requiresAccessConfiguration(),false);const raw=d.backup(owner);d.close();Domain.restore(join(dir,'target'),raw,owner,seed.manifest);d=new Domain(join(dir,'target'),seed);assert.equal(d.requiresAccessConfiguration(),true);d.close();d=new Domain(join(dir,'target'),seed);assert.equal(d.requiresAccessConfiguration(),true);
 assert.throws(()=>d.confirmAccessConfiguration({id:'client',owner:false,scopes:['foldy:read']}),/OWNER_REQUIRED/);assert.equal(d.requiresAccessConfiguration(),true);
 assert.throws(()=>d.dispatch('confirmAccessConfiguration',{owner:true},owner),/SCOPE_REQUIRED/);assert.throws(()=>d.dispatch('get_project',{owner:true},owner),/REQUEST_INVALID/);assert.equal(d.requiresAccessConfiguration(),true);
 const sql=new DatabaseSync(join(dir,'target'));sql.exec('BEGIN IMMEDIATE');assert.throws(()=>d.confirmAccessConfiguration(owner),/locked|busy/i);sql.exec('ROLLBACK');sql.close();assert.equal(d.requiresAccessConfiguration(),true);
 assert.ok(!d.backup(owner).includes('recovery_access_required'));d.confirmAccessConfiguration(owner);assert.equal(d.requiresAccessConfiguration(),false);d.close();d=new Domain(join(dir,'target'),seed);assert.equal(d.requiresAccessConfiguration(),false);Domain.restore(join(dir,'again'),d.backup(owner),owner,seed.manifest);const again=new Domain(join(dir,'again'),seed);assert.equal(again.requiresAccessConfiguration(),true);again.close();
 }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
test('empty comment targets and stale approval receipts remain valid; missing state receipts do not',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-receipts-'));const d=new Domain(join(dir,'source'),seed);let n=0;
 const run=(op:string,extra:any={})=>d.dispatch(op,{projectId:'p',expectedBaseRevisionId:d.current(),idempotencyKey:String(++n),...extra},owner);
 try{let a=run('create_update',{title:'proposal'});const ref={updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId};run('add_review_comment',{...ref,text:'note',blocking:false,target:{path:'',block:'',field:'',selection:''}});assert.doesNotThrow(()=>d.backup(owner));run('submit_update_for_review',ref);run('approve_update_revision',{...ref,reason:'ok'});
 a=run('save_update_revision',ref);ref.expectedUpdateRevisionId=a.updateRevisionId;assert.doesNotThrow(()=>d.backup(owner));run('submit_update_for_review',ref);run('approve_update_revision',{...ref,reason:'new approval'});run('publish_update',{...ref,reason:'publish'});
 const raw=d.backup(owner);for(const mutate of [(e:any)=>e.payload.receipts=[],(e:any)=>e.payload.receipts=e.payload.receipts.filter((r:any)=>r.value.operation!=='approve_update_revision'),(e:any)=>e.payload.receipts=e.payload.receipts.filter((r:any)=>r.value.operation!=='publish_update'),(e:any)=>{e.payload.receipts.find((r:any)=>r.value.operation==='publish_update').value.priorState='Draft';}]){const e=JSON.parse(raw);mutate(e);e.sha256=digest(JSON.stringify(e.payload));assert.throws(()=>Domain.restore(join(dir,'bad'),JSON.stringify(e),owner,seed.manifest),/BACKUP_INVALID/);assert.equal(existsSync(join(dir,'bad')),false);}
 Domain.restore(join(dir,'good'),raw,owner,seed.manifest);
 }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
test('backup uses SQLite writer interlock and releases it after success',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-lock-'));const path=join(dir,'db');const d=new Domain(path,seed),other=new DatabaseSync(path);
 try{other.exec('BEGIN IMMEDIATE');assert.throws(()=>d.backup(owner),/locked|busy/i);other.exec('ROLLBACK');const snapshot=d.backup(owner);other.exec('BEGIN IMMEDIATE; ROLLBACK');assert.equal(JSON.parse(snapshot).payload.current,'base');}finally{other.close();d.close();rmSync(dir,{recursive:true,force:true});}
});
const seed={manifest:{instanceId:'i',projectId:'p',workbookId:'w',revisionId:'base'},files:new Map([['index.html',{bytes:Buffer.from('initial'),mediaType:'text/html'}]])};
test('consistent custody-free snapshot restores history and permits fresh authorized publication',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-'));let d=new Domain(join(dir,'source'),seed);let n=0;
 const run=(op:string,extra:any={})=>d.dispatch(op,{projectId:'p',expectedBaseRevisionId:d.current(),idempotencyKey:String(++n),...extra},owner);
 const publish=()=>{let a=run('create_update',{title:'proposal'});let ref={updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId};a=run('update_page',{...ref,path:'index.html',content:'changed'+n});ref.expectedUpdateRevisionId=a.updateRevisionId;run('submit_update_for_review',ref);const c=run('add_review_comment',{...ref,text:'fix',blocking:true,target:{path:'index.html'}});run('resolve_review_comment',{...ref,commentId:c.commentId,reason:'fixed'});run('approve_update_revision',{...ref,reason:'approved'});return run('publish_update',{...ref,reason:'publish'});};
 try{publish();run('create_update',{title:'isolated'});const current=d.current(),bytes=d.file('index.html')!.bytes;
 const sql=new DatabaseSync(join(dir,'source'));sql.exec('CREATE TABLE auth(secret TEXT)');sql.prepare('INSERT INTO auth VALUES(?)').run('CUSTODY_CANARY_NOT_REAL_CREDENTIAL');sql.prepare('INSERT INTO meta VALUES(?,?)').run('bootstrapHash','CUSTODY_CANARY_NOT_REAL_CREDENTIAL');sql.close();
 assert.throws(()=>d.backup({id:'client',owner:false,scopes:['foldy:read']}),/OWNER_REQUIRED/);
 const backup=d.backup(owner);assert.ok(!backup.includes('CUSTODY_CANARY'));assert.ok(!backup.includes('bootstrapHash'));d.close();rmSync(join(dir,'source'));
 const restored=Domain.restore(join(dir,'target'),backup,owner,seed.manifest);assert.equal(restored.state,'SEALED');assert.equal(restored.requiresFreshBootstrap,true);
 d=new Domain(join(dir,'target'),seed);assert.equal(d.current(),current);assert.deepEqual(d.file('index.html')!.bytes,bytes);assert.equal(d.file('index.html','base')!.bytes.toString(),'initial');assert.equal(d.dispatch('list_updates',{},owner).value.length,2);publish();assert.notEqual(d.current(),current);
 const db=new DatabaseSync(join(dir,'target'));assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name),['meta','receipts','revisions','updates']);db.close();assert.throws(()=>Domain.restore(join(dir,'target'),backup,owner,seed.manifest),/TARGET_EXISTS/);
 }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
test('untrusted backups reject corruption, schema, identity, traversal and broken references before target creation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-bad-'));const d=new Domain(join(dir,'source'),seed);
 try{const raw=d.backup(owner);const bad=[(e:any)=>e.schemaVersion='future',(e:any)=>e.payload.current='missing',(e:any)=>e.payload.revisions[0].parent='base',(e:any)=>e.payload.identity.projectId='wrong',(e:any)=>{e.payload.revisions[0].files['../escape']=e.payload.revisions[0].files['index.html'];},(e:any)=>e.payload.revisions[0].files['index.html'].content='YmFk'];
 for(const mutate of bad){const e=JSON.parse(raw);mutate(e);e.sha256=digest(JSON.stringify(e.payload));assert.throws(()=>Domain.restore(join(dir,'target'),JSON.stringify(e),owner,seed.manifest));assert.equal(existsSync(join(dir,'target')),false);}
 assert.throws(()=>Domain.restore(join(dir,'target'),raw.replace('initial','bad')+'x',owner,seed.manifest));assert.equal(existsSync(join(dir,'target')),false);
 }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
