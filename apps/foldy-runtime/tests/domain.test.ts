import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../dist/domain.js';
test('transactional isolated revisions, review gates, stale approval, idempotency and persistence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foldy-domain-')); const seed={manifest:{instanceId:'i',projectId:'p',workbookId:'w',revisionId:'base'},files:new Map([['index.html',{bytes:Buffer.from('initial'),mediaType:'text/html'}]])};
 let d=new Domain(join(dir,'content.sqlite'),seed);const owner={id:'owner',owner:true,scopes:[]},client={id:'client',owner:false,scopes:['foldy:read','foldy:draft:write']};let n=0;
 const run=(op:string,extra:any={},actor=owner)=>d.dispatch(op,{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:String(++n),...extra},actor);
 try{
 const a=run('create_update',{title:'Proposal'},client),b=run('create_update',{title:'Other'},client);let ref={updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId};
 assert.throws(()=>run('approve_update_revision',{...ref,reason:'yes'},client),/SCOPE_REQUIRED/);
 const edit=run('update_page',{...ref,path:'index.html',content:'changed'},client);ref.expectedUpdateRevisionId=edit.updateRevisionId;assert.equal(d.file('index.html')?.bytes.toString(),'initial');
 run('submit_update_for_review',ref,client);run('approve_update_revision',{...ref,reason:'reviewed'});
 const newer=run('update_page',{...ref,path:'index.html',content:'newer'},client);ref.expectedUpdateRevisionId=newer.updateRevisionId;
 assert.throws(()=>run('publish_update',{...ref,reason:'publish'}),/APPROVAL_STALE/);
 run('submit_update_for_review',ref,client);
 const comment=run('add_review_comment',{...ref,text:'fix this',blocking:true,target:{path:'index.html',field:'heading'}});
 assert.throws(()=>run('approve_update_revision',{...ref,reason:'reviewed'}),/BLOCKING_COMMENTS/);
 run('resolve_review_comment',{...ref,commentId:comment.commentId,reason:'fixed'});run('submit_update_for_review',ref);run('approve_update_revision',{...ref,reason:'reviewed'});
 const args={projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:'publish',...ref,reason:'publish'};const published=d.dispatch('publish_update',args,owner);assert.deepEqual(d.dispatch('publish_update',args,owner),published);assert.throws(()=>d.dispatch('publish_update',{...args,reason:'different'},owner),/IDEMPOTENCY_CONFLICT/);
 assert.equal(d.file('index.html')?.bytes.toString(),'newer');assert.equal(d.file('index.html','base')?.bytes.toString(),'initial');
 assert.throws(()=>run('publish_update',{updateId:b.updateId,expectedUpdateRevisionId:b.updateRevisionId,reason:'conflict'}),/REVISION_CONFLICT/);
 assert.throws(()=>d.dispatch('get_project',{unknown:true},client),/REQUEST_INVALID/);
 assert.throws(()=>d.dispatch('get_project',JSON.parse('{"constructor":"injected"}'),client),/REQUEST_INVALID/);
 assert.throws(()=>d.dispatch('list_updates',{atRevisionId:'base'},client),/REVISION_CONFLICT/);
 d.close();d=new Domain(join(dir,'content.sqlite'),seed);assert.equal(d.current(),published.currentPublishedRevisionId);assert.equal(d.file('index.html')?.bytes.toString(),'newer');
 }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
test('revision-bound page and workbook reads search only the selected content snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'foldy-knowledge-'));
 const seed={manifest:{instanceId:'i',projectId:'p',workbookId:'w',revisionId:'base'},files:new Map([
  ['index.html',{bytes:Buffer.from('<h1>Alpha launch</h1>'),mediaType:'text/html'}],
  ['pages/about.html',{bytes:Buffer.from('<h1>About Alpha</h1>'),mediaType:'text/html'}],
  ['workbook.json',{bytes:Buffer.from('{"title":"Alpha workbook"}'),mediaType:'application/json'}],
  ['assets/icon.png',{bytes:Buffer.from('Alpha binary'),mediaType:'image/png'}],
 ])};
 const d=new Domain(join(dir,'content.sqlite'),seed);const reader={id:'reader',owner:false,scopes:['foldy:read']};
 try{
  for(const name of ['get_workbook','list_pages','get_page','search'])assert.ok(d.tools(reader).some(t=>t.name===name));
  assert.deepEqual(d.dispatch('get_workbook',{},reader),{observedRevisionId:'base',value:{path:'workbook.json',content:'{"title":"Alpha workbook"}'}});
  assert.deepEqual(d.dispatch('list_pages',{},reader).value,['index.html','pages/about.html']);
  assert.deepEqual(d.dispatch('get_page',{path:'pages/about.html'},reader).value,{path:'pages/about.html',content:'<h1>About Alpha</h1>'});
  const matches=d.dispatch('search',{query:'alpha'},reader);
  assert.equal(matches.observedRevisionId,'base');
  assert.deepEqual(matches.value.map((match:{path:string})=>match.path),['index.html','pages/about.html','workbook.json']);
  assert.throws(()=>d.dispatch('get_page',{path:'assets/icon.png'},reader),/FILE_UNAVAILABLE/);
  assert.throws(()=>d.dispatch('get_page',{path:'constructor'},reader),/FILE_UNAVAILABLE/);
  assert.throws(()=>d.dispatch('search',{query:'Alpha',unknown:'x'},reader),/REQUEST_INVALID/);
  assert.throws(()=>d.dispatch('search',{query:'Alpha',atRevisionId:'missing'},reader),/REVISION_CONFLICT/);
  const owner={id:'owner',owner:true,scopes:[]};
  const created=d.dispatch('create_update',{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:'create',title:'New about'},owner);
  const changed=d.dispatch('update_page',{projectId:'p',expectedBaseRevisionId:'base',idempotencyKey:'edit',updateId:created.updateId,expectedUpdateRevisionId:created.updateRevisionId,path:'pages/about.html',content:'<h1>Beta page</h1>'},owner);
  const decision={projectId:'p',expectedBaseRevisionId:'base',updateId:created.updateId,expectedUpdateRevisionId:changed.updateRevisionId};
  d.dispatch('submit_update_for_review',{...decision,idempotencyKey:'submit'},owner);
  d.dispatch('approve_update_revision',{...decision,idempotencyKey:'approve',reason:'Reviewed'},owner);
  d.dispatch('publish_update',{...decision,idempotencyKey:'publish',reason:'Approved'},owner);
  assert.deepEqual(d.dispatch('search',{query:'beta'},reader).value.map((match:{path:string})=>match.path),['pages/about.html']);
  assert.deepEqual(d.dispatch('search',{query:'beta',atRevisionId:'base'},reader).value,[]);
  assert.equal(d.dispatch('get_page',{path:'pages/about.html',atRevisionId:'base'},reader).value.content,'<h1>About Alpha</h1>');
 }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
