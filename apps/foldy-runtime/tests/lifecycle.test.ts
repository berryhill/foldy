import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import * as lifecycle from '../dist/lifecycle.js';
import { digest } from '../dist/bundle.js';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Domain } from '../dist/domain.js';
import { LifecycleCoordinator, readLifecycleTombstone, type LifecycleDriver, type LifecycleStep, type StepResult } from '../dist/lifecycle.js';

// Fixture driver ONLY. These tests do not establish Cynder capability or live deletion.
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'foldy-lifecycle-')); const data=join(dir,'data'), tomb=join(dir,'external');mkdirSync(data,{mode:0o700});mkdirSync(tomb,{mode:0o700});
 const path=join(data,'content.sqlite');const domain=new Domain(path,{manifest:{instanceId:'i',projectId:'p',workbookId:'w',revisionId:'r'},files:new Map([['index.html',{bytes:Buffer.from('fixture'),mediaType:'text/html'}]])});
 const calls:LifecycleStep[]=[]; const observed=new Map<LifecycleStep,StepResult>();let blocked:LifecycleStep|undefined;let unsupported:LifecycleStep|undefined;let onApply=()=>{};
 const driver:LifecycleDriver={capability:s=>s===unsupported?'unsupported':'verified',verifyBackup:r=>r==='verified-backup'?'verified':'unknown',apply(s){calls.push(s);onApply();const result:StepResult={status:'verified',instanceId:'i',dataRetained:true,ready:true};observed.set(s,result);return result;},readback(s){return s===blocked?{status:'unknown'}:observed.get(s)??{status:'unknown'};}};
 const options={databasePath:path,dataRoot:data,tombstoneDirectory:tomb,identity:{instanceId:'i',projectId:'p',workbookId:'w',instanceName:'Exact Name'},authorizeOwner:(c:unknown)=>c==='owner'?{actorRef:'owner'}:null,driver};
 let coordinator=new LifecycleCoordinator(options);
 return {domain,calls,path,tomb,options,driver,get coordinator(){return coordinator;},block(s?:LifecycleStep){blocked=s;},unsupported(s?:LifecycleStep){unsupported=s;},onApply(fn:()=>void){onApply=fn;},reopen(){coordinator.close();coordinator=new LifecycleCoordinator(options);},cleanup(){coordinator.close();domain.close();rmSync(dir,{recursive:true,force:true});}};
}
test('fixture: owner admission, exact replay, generations, stop retention and readiness-before-traffic',()=>{
 const f=fixture();try{
 const stop={operationId:'stop',kind:'stop' as const,expectedGeneration:0};
 assert.throws(()=>f.coordinator.execute('viewer',stop),/OWNER_REQUIRED/);
 assert.equal(f.coordinator.execute('owner',stop).status,'complete');assert.equal(f.coordinator.state().mode,'stopped');assert.equal(f.domain.file('index.html')!.bytes.toString(),'fixture');
 assert.equal(f.coordinator.execute('owner',stop).generation,1);assert.deepEqual(f.calls,['traffic_off','workload_stop']);
 assert.throws(()=>f.coordinator.execute('owner',{...stop,kind:'resume'}),/IDEMPOTENCY_CONFLICT/);
 assert.throws(()=>f.coordinator.execute('owner',{operationId:'bad',kind:'resume',expectedGeneration:0}),/GENERATION_CONFLICT/);
 assert.equal(f.coordinator.execute('owner',{operationId:'resume',kind:'resume',expectedGeneration:1}).status,'complete');
 assert.deepEqual(f.calls,['traffic_off','workload_stop','workload_start','readiness','traffic_on']);
 }finally{f.cleanup();}
});
test('fixture: unknown persists across reopen, gates mutation and new operations, reconciles without reapply',()=>{
 const f=fixture();try{
 f.block('workload_stop');const input={operationId:'stop',kind:'stop' as const,expectedGeneration:0};
 assert.equal(f.coordinator.execute('owner',input).status,'blocked');assert.notEqual(f.coordinator.state().mode,'stopped');f.reopen();
 assert.throws(()=>f.coordinator.execute('owner',{operationId:'other',kind:'stop',expectedGeneration:0}),/INTERLOCK/);
 assert.throws(()=>f.domain.dispatch('create_update',{projectId:'p',title:'blocked',expectedBaseRevisionId:'r',idempotencyKey:'draft'},{id:'owner',owner:true,scopes:[]}),/INTERLOCK/);
 const db=new DatabaseSync(f.path);try{db.exec('BEGIN IMMEDIATE');assert.throws(()=>LifecycleCoordinator.assertIdle(db),/INTERLOCK/);db.exec('ROLLBACK');}finally{db.close();}
 f.block();assert.equal(f.coordinator.execute('owner',input).status,'complete');assert.deepEqual(f.calls,['traffic_off','workload_stop']);
 }finally{f.cleanup();}
});
test('fixture: actual SQLite interlock excludes backup during driver effect',()=>{
 const f=fixture();try{
 let checked=0;f.onApply(()=>{assert.throws(()=>f.domain.backup({id:'owner',owner:true,scopes:[]}),/locked|busy/i);checked++;});
 f.coordinator.execute('owner',{operationId:'stop',kind:'stop',expectedGeneration:0});assert.equal(checked,2);
 }finally{f.cleanup();}
});
test('fixture: delete confirmation, verified backup decision, separate ordered outcomes and protected external tombstone',()=>{
 const f=fixture();try{
 const input={operationId:'delete',kind:'delete' as const,expectedGeneration:0,confirmation:'Exact Name',backup:{kind:'skip' as const}};
 assert.throws(()=>f.coordinator.execute('owner',{...input,confirmation:'exact name'}),/CONFIRM/);
 assert.throws(()=>f.coordinator.execute('owner',{...input,backup:undefined}),/BACKUP/);
 assert.throws(()=>f.coordinator.execute('owner',{...input,backup:{kind:'verified',reference:'missing'}}),/BACKUP_UNVERIFIED/);
 f.block('cache');assert.equal(f.coordinator.execute('owner',input).status,'blocked');assert.deepEqual(f.calls,['traffic_off','workload_stop','credentials','cache']);
 assert.equal(readLifecycleTombstone(f.tomb,'delete').steps.cache?.status,'unknown');f.reopen();f.block();
 const result=f.coordinator.execute('owner',input);assert.equal(result.status,'complete');assert.deepEqual(f.calls,['traffic_off','workload_stop','credentials','cache','artifact','volume']);
 assert.equal(readLifecycleTombstone(f.tomb,'delete').status,'complete');assert.equal(result.input.backup?.kind,'skip');assert.equal(f.coordinator.execute('owner',input).status,'complete');
 }finally{f.cleanup();}
});
test('fixture: unsupported compute never becomes stopped; upgrade and internal tombstones rejected',()=>{
 const f=fixture();try{
 assert.throws(()=>f.coordinator.execute('owner',{operationId:'up',kind:'upgrade',expectedGeneration:0}),/UPGRADE_UNSUPPORTED/);
 assert.throws(()=>new LifecycleCoordinator({...f.options,tombstoneDirectory:f.options.dataRoot}),/EXTERNAL/);
 f.unsupported('workload_stop');const op=f.coordinator.execute('owner',{operationId:'stop',kind:'stop',expectedGeneration:0});assert.equal(op.status,'blocked');assert.equal(op.steps.workload_stop?.status,'unsupported');assert.notEqual(f.coordinator.state().mode,'stopped');assert.deepEqual(f.calls,['traffic_off']);
 }finally{f.cleanup();}
});
test('pending lifecycle blocks backup between effects and after restart; snapshots exclude lifecycle',()=>{
 const f=fixture();const owner={id:'owner',owner:true,scopes:[]};try{
 const raw=f.domain.backup(owner);assert.ok(!raw.includes('lifecycle'));
 const sql=new DatabaseSync(f.path);sql.prepare("UPDATE lifecycle_state SET active='pending'").run();sql.close();
 assert.throws(()=>f.domain.backup(owner),/LIFECYCLE_INTERLOCK/);f.reopen();
 assert.throws(()=>f.domain.backup(owner),/LIFECYCLE_INTERLOCK/);
 const e=JSON.parse(raw);e.payload.lifecycle_state={active:'pending'};e.sha256=digest(JSON.stringify(e.payload));
 assert.throws(()=>Domain.restore(join(f.options.dataRoot,'restore'),JSON.stringify(e),owner,{instanceId:'i',projectId:'p',workbookId:'w',revisionId:'r'}),/BACKUP_INVALID/);
 }finally{f.cleanup();}
});
test('unknown, failed, wrong-instance and thrown readback cannot complete deletion',()=>{
 for(const result of [{status:'unknown'},{status:'failed'},{status:'verified',instanceId:'other'},null]){
 const f=fixture();try{f.driver.readback=()=>{if(result===null)throw Error('fixture failure');return result as StepResult;};
 const op=f.coordinator.execute('owner',{operationId:'delete',kind:'delete',expectedGeneration:0,confirmation:'Exact Name',backup:{kind:'skip'}});
 assert.equal(op.status,'blocked');assert.notEqual(f.coordinator.state().mode,'deleted');assert.ok(!f.calls.includes('volume'));
 }finally{f.cleanup();}}
});
test('concurrent external tombstones are identical-idempotent and conflicting-input safe',async()=>{
 const f=fixture();try{
 assert.equal(typeof lifecycle.writeLifecycleTombstone,'function');
 f.block('traffic_off');const op=f.coordinator.execute('owner',{operationId:'delete',kind:'delete',expectedGeneration:0,confirmation:'Exact Name',backup:{kind:'skip'}});
 const directory=join(f.options.dataRoot,'../race');mkdirSync(directory,{mode:0o700});
 const run=(value:unknown)=>new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',`import {writeLifecycleTombstone} from ${JSON.stringify(new URL('../dist/lifecycle.js',import.meta.url).href)};try{writeLifecycleTombstone(process.argv[1],JSON.parse(process.argv[2]));}catch{process.exitCode=2;}`,directory,JSON.stringify(value)],{stdio:'ignore'});child.on('error',reject);child.on('exit',resolve);});
 assert.deepEqual(await Promise.all([run(op),run(op),run(op)]),[0,0,0]);
 const different={...op,actorRef:'other'};different.inputDigest=digest(JSON.stringify([different.identity,different.actorRef,different.input]));
 assert.deepEqual(await Promise.all([run(op),run(different)]),[0,2]);
 assert.equal(readLifecycleTombstone(directory,'delete').inputDigest,op.inputDigest);
 }finally{f.cleanup();}
});
