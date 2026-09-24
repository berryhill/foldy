import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Domain } from '../dist/domain.js';
test('owner can close a stale conflicting proposal without changing publication or losing decision history',()=>{
 const root=mkdtempSync(join(tmpdir(),'foldy-decisions-'));
 const seed={manifest:{instanceId:'i1',projectId:'p1',workbookId:'w1',revisionId:'r1'},files:new Map([['index.html',{bytes:Buffer.from('<h1>Original</h1>'),mediaType:'text/html'}]])};
 const file=join(root,'content.sqlite');let domain=new Domain(file,seed);const owner={id:'owner',owner:true,scopes:[]};
 const op=(name:string,args:Record<string,unknown>)=>domain.dispatch(name,args,owner);
 const create=(title:string)=>{const r=op('create_update',{projectId:'p1',expectedBaseRevisionId:'r1',title,idempotencyKey:randomUUID()});return {projectId:'p1',expectedBaseRevisionId:'r1',updateId:r.updateId,expectedUpdateRevisionId:r.updateRevisionId};};
 try{
 const a=create('Publish'),b=create('Abandon stale');
 for(const ref of [a,b]){const r=op('update_page',{...ref,path:'index.html',content:'<h1>'+ref.updateId+'</h1>',idempotencyKey:randomUUID()});ref.expectedUpdateRevisionId=r.updateRevisionId;}
 for(const name of ['submit_update_for_review','approve_update_revision','publish_update'])op(name,{...a,idempotencyKey:randomUUID(),...(name==='submit_update_for_review'?{}:{reason:'Accepted'})});
 const current=domain.current();
 assert.throws(()=>domain.dispatch('close_update',{...b,reason:'Owner only',idempotencyKey:randomUUID()},{id:'client',owner:false,scopes:['foldy:read','foldy:draft:write']}),/SCOPE_REQUIRED/);
 const close={...b,reason:'Superseded by the published proposal',idempotencyKey:randomUUID()};
 const receipt=op('close_update',close);assert.equal(receipt.currentState,'Closed');assert.equal(domain.current(),current);assert.deepEqual(op('close_update',close),receipt);
 domain.close();domain=new Domain(file,seed);
 const update=op('get_update',{updateId:b.updateId}).value;assert.equal(update.state,'Closed');assert.equal(update.revision,b.expectedUpdateRevisionId);
 assert.equal(update.decisions.at(-1).reason,close.reason);assert.equal(update.decisions.at(-1).receiptId,receipt.receiptId);assert.equal(domain.current(),current);
 const backup=domain.backup(owner),restoredPath=join(root,'restored.sqlite');Domain.restore(restoredPath,backup,owner,seed.manifest);const restored=new Domain(restoredPath,seed);try{assert.equal(restored.current(),current);assert.equal(restored.dispatch('get_update',{updateId:b.updateId},owner).value.decisions.at(-1).reason,close.reason);}finally{restored.close();}
 }finally{domain.close();rmSync(root,{recursive:true,force:true});}
});


test('same-millisecond decisions retain transaction order after backup and restore',t=>{
 t.mock.timers.enable({apis:['Date'],now:1789800000000});
 const root=mkdtempSync(join(tmpdir(),'foldy-order-'));
 const seed={manifest:{instanceId:'i1',projectId:'p1',workbookId:'w1',revisionId:'r1'},files:new Map([['index.html',{bytes:Buffer.from('<h1>Original</h1>'),mediaType:'text/html'}]])};
 const owner={id:'owner',owner:true,scopes:[]},domain=new Domain(join(root,'source.sqlite'),seed);
 try{
 const created=domain.dispatch('create_update',{projectId:'p1',expectedBaseRevisionId:'r1',title:'Decision order',idempotencyKey:'z-create'},owner);
 const ref={projectId:'p1',expectedBaseRevisionId:'r1',updateId:created.updateId,expectedUpdateRevisionId:created.updateRevisionId};
 domain.dispatch('request_update_changes',{...ref,reason:'First',idempotencyKey:'y-request'},owner);
 domain.dispatch('close_update',{...ref,reason:'Last',idempotencyKey:'a-close'},owner);
 const before=domain.dispatch('get_update',{updateId:ref.updateId},owner).value.decisions;
 assert.deepEqual(before.map(d=>d.reason),['First','Last']);assert.equal(before[0].occurredAt,before[1].occurredAt);
 const backup=domain.backup(owner),target=join(root,'restored.sqlite');
 const altered=JSON.parse(backup);altered.payload.receipts.reverse();altered.sha256=createHash('sha256').update(JSON.stringify(altered.payload)).digest('hex');
 assert.throws(()=>Domain.restore(join(root,'reordered.sqlite'),JSON.stringify(altered),owner,seed.manifest),/BACKUP_INVALID/);
 Domain.restore(target,backup,owner,seed.manifest);
 const restored=new Domain(target,seed);try{assert.deepEqual(restored.dispatch('get_update',{updateId:ref.updateId},owner).value.decisions,before);}finally{restored.close();}
 }finally{domain.close();rmSync(root,{recursive:true,force:true});}
});
