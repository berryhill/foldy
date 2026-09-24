import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Domain} from '../dist/domain.js';
import {digest} from '../dist/bundle.js';
const owner={id:'owner',owner:true,scopes:[]};
const seed={manifest:{instanceId:'i',projectId:'p',workbookId:'w',revisionId:'base'},files:new Map(['index.html','a.txt','b.txt'].map(p=>[p,{bytes:Buffer.from(p),mediaType:p.endsWith('html')?'text/html':'text/plain'}]))};
function fixture(fn:(d:Domain,run:any,dir:string)=>void){const dir=mkdtempSync(join(tmpdir(),'refresh-'));const d=new Domain(join(dir,'db'),seed);let n=0;const run=(op:string,a:any={})=>d.dispatch(op,{projectId:'p',expectedBaseRevisionId:d.current(),idempotencyKey:String(++n),...a},owner);try{fn(d,run,dir);}finally{d.close();rmSync(dir,{recursive:true,force:true});}}
function ref(a:any){return {updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId};}
function approve(run:any,a:any){run('submit_update_for_review',ref(a));run('approve_update_revision',{...ref(a),reason:'reviewed'});}
function publish(run:any,a:any){approve(run,a);return run('publish_update',{...ref(a),reason:'publish'});}
test('clean refresh preserves old revisions/comments, invalidates approval and restores branched publication history',()=>fixture((d,run,dir)=>{
 let a=run('create_update',{title:'proposal'});a=run('update_page',{...ref(a),path:'a.txt',content:'proposal'});run('add_review_comment',{...ref(a),text:'keep history',blocking:false,target:{path:'a.txt'}});approve(run,a);
 let b=run('create_update',{title:'other'});b=run('update_page',{...ref(b),path:'b.txt',content:'published'});publish(run,b);
 const old=a.updateRevisionId;const args={...ref(a),expectedBaseRevisionId:'base',newPublishedBaseRevisionId:d.current(),idempotencyKey:'refresh'};
 a=run('refresh_update_proposal',args);assert.notEqual(a.updateRevisionId,old);assert.equal(a.currentState,'Draft');assert.deepEqual(run('refresh_update_proposal',args),a);
 const u=d.dispatch('get_update',{updateId:a.updateId},owner).value;assert.equal(u.base,b.updateRevisionId);assert.equal(u.approval,undefined);assert.equal(u.comments[0].revision,old);assert.equal(d.file('b.txt',old)?.bytes.toString(),'b.txt');assert.equal(d.file('b.txt',a.updateRevisionId)?.bytes.toString(),'published');assert.equal(d.file('a.txt',a.updateRevisionId)?.bytes.toString(),'proposal');assert.throws(()=>run('publish_update',{...ref(a),reason:'stale'}),/REVIEW_REQUIRED/);publish(run,a);
 const backup=d.backup(owner);for(const change of [(p:any)=>{p.receipts.find((r:any)=>r.value.operation==='refresh_update_proposal').value.refreshEvidence.previousBaseRevisionId=b.updateRevisionId;},(p:any)=>{p.revisions.find((r:any)=>r.id===a.updateRevisionId).parent=a.updateRevisionId;}]){const bad=JSON.parse(backup);change(bad.payload);bad.sha256=digest(JSON.stringify(bad.payload));assert.throws(()=>Domain.restore(join(dir,'bad'),JSON.stringify(bad),owner,seed.manifest),/BACKUP_INVALID/);}Domain.restore(join(dir,'restore'),backup,owner,seed.manifest);const restored=new Domain(join(dir,'restore'),seed);try{assert.equal(restored.backup(owner),backup);}finally{restored.close();}
}));
test('path conflicts and stale expectations leave backup bytes and receipt set unchanged',()=>fixture((d,run)=>{
 let a=run('create_update',{title:'proposal'});a=run('update_page',{...ref(a),path:'a.txt',content:'proposal'});let b=run('create_update',{title:'other'});b=run('update_page',{...ref(b),path:'a.txt',content:'published'});publish(run,b);const before=d.backup(owner);
 const args={...ref(a),expectedBaseRevisionId:'base',newPublishedBaseRevisionId:d.current()};const result=run('refresh_update_proposal',args);assert.equal(result.code,'REFRESH_CONFLICT');assert.deepEqual(result.conflicts,[{path:'a.txt'}]);assert.equal(d.backup(owner),before);
 for(const patch of [{newPublishedBaseRevisionId:'base'},{expectedUpdateRevisionId:'base'},{expectedBaseRevisionId:b.updateRevisionId}]){assert.throws(()=>run('refresh_update_proposal',{...args,...patch}),/REVISION_CONFLICT/);assert.equal(d.backup(owner),before);}
 assert.throws(()=>run('refresh_update_proposal',{...args,force:true}),/REQUEST_INVALID/);
}));
test('authenticated seed protected paths are copied and deny edits even for owner',()=>{
 const paths=['a.txt'];const d=new Domain(':memory:',{...seed,protectedPaths:paths});paths.length=0;try{const a=d.dispatch('create_update',{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:'1',title:'protect'},owner);for(const [op,args] of [['update_page',{path:'a.txt',content:'bad'}],['remove_page',{path:'a.txt'}],['move_page',{path:'a.txt',destinationPath:'c.txt'}],['move_page',{path:'b.txt',destinationPath:'a.txt'}]])assert.throws(()=>d.dispatch(op as string,{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:op,...ref(a),...args},owner),/PROTECTED_PATH/);}finally{d.close();}
});

for(const scenario of ['same-edit','delete-edit','add-add','delete-delete'])test(`refresh three-way ${scenario}`,()=>fixture((d,run)=>{
 let a=run('create_update',{title:'a'}),b=run('create_update',{title:'b'});
 const edit=(u:any,side:string)=>scenario==='add-add'?run('create_page',{...ref(u),path:'new.txt',content:side,mediaType:'text/plain'}):scenario==='delete-delete'||(scenario==='delete-edit'&&side==='a')?run('remove_page',{...ref(u),path:'a.txt'}):run('update_page',{...ref(u),path:'a.txt',content:scenario==='same-edit'?'same':side});
 a=edit(a,'a');b=edit(b,'b');publish(run,b);const before=d.backup(owner);const result=run('refresh_update_proposal',{...ref(a),expectedBaseRevisionId:'base',newPublishedBaseRevisionId:d.current()});
 if(['delete-edit','add-add'].includes(scenario)){assert.equal(result.code,'REFRESH_CONFLICT');assert.equal(d.backup(owner),before);}else{assert.equal(result.currentState,'Draft');assert.equal(d.file('a.txt',result.updateRevisionId)?.bytes.toString(),scenario==='same-edit'?'same':undefined);d.backup(owner);}
}));
test('another connection advancing publication rejects previously observed refresh base',()=>fixture((d,run,dir)=>{
 const a=run('create_update',{title:'a'});let b=run('create_update',{title:'b'});b=run('update_page',{...ref(b),path:'b.txt',content:'b'});publish(run,b);const observed=d.current();
 const peer=new Domain(join(dir,'db'),seed);try{let n=0;const invoke=(op:string,args:any)=>peer.dispatch(op,{projectId:'p',expectedBaseRevisionId:peer.current(),idempotencyKey:'peer'+(++n),...args},owner);const c=invoke('create_update',{title:'c'});publish(invoke,c);}finally{peer.close();}
 const before=d.backup(owner);assert.throws(()=>run('refresh_update_proposal',{...ref(a),expectedBaseRevisionId:'base',newPublishedBaseRevisionId:observed}),/REVISION_CONFLICT/);assert.equal(d.backup(owner),before);
}));
