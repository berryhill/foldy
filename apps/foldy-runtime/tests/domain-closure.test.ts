import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../dist/domain.js';
import { digest } from '../dist/bundle.js';
const owner={id:'owner',owner:true,scopes:[] as string[]};
const client={id:'client',owner:false,scopes:['foldy:read','foldy:draft:write']};
const seed={manifest:{instanceId:'i',projectId:'p',workbookId:'w',revisionId:'base'},files:new Map([
 ['index.html',{bytes:Buffer.from('<link href="styles/main.css">'),mediaType:'text/html'}],
 ['styles/main.css',{bytes:Buffer.from('@import "nested.css";'),mediaType:'text/css'}],
 ['styles/nested.css',{bytes:Buffer.from('body {color:red}'),mediaType:'text/css'}],
])};
function fixture(fn:(d:Domain,run:(op:string,args?:any,actor?:typeof owner)=>any,dir:string)=>void){const dir=mkdtempSync(join(tmpdir(),'foldy-closure-'));const d=new Domain(join(dir,'source'),seed);let n=0;try{fn(d,(op,args={},actor=owner)=>d.dispatch(op,{projectId:'p',expectedBaseRevisionId:d.current(),idempotencyKey:String(++n),...args},actor),dir);}finally{d.close();rmSync(dir,{recursive:true,force:true});}}
test('recursive CSS missing dependency blocks review and keeps draft and receipts intact',()=>fixture((d,run)=>{
 let a=run('create_update',{title:'broken'},client);const ref={updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId};
 a=run('update_page',{...ref,path:'styles/nested.css',content:'body {background:url("../missing.png")}'});ref.expectedUpdateRevisionId=a.updateRevisionId;
 const before=d.backup(owner);assert.throws(()=>run('submit_update_for_review',ref),/CHECKS_FAILED/);assert.equal(d.backup(owner),before);
 const checks=d.dispatch('get_readiness_checks',{updateId:a.updateId},owner).value;assert.equal(checks.dependencies.pass,false);assert.ok(checks.dependencies.failures.some((x:any)=>x.reference==='../missing.png'));
}));
for(const [label,path,content,reason] of [
 ['unquoted srcset','index.html','<img srcset=missing.png>','MISSING_DEPENDENCY'],
 ['escaped CSS url','styles/nested.css',String.raw`body {background:u\72l(missing.png)}`,'UNSUPPORTED_ESCAPE'],
 ['escaped CSS import','styles/nested.css',String.raw`@im\70ort 'missing.css';`,'UNSUPPORTED_ESCAPE'],
 ['inline escaped CSS','index.html',String.raw`<style>body {background:u\72l(missing.png)}</style>`,'UNSUPPORTED_ESCAPE'],
 ['numeric HTML entity','index.html','<img src="&#109;issing.png">','UNSUPPORTED_HTML_ENTITY'],
 ['named HTML entity','index.html','<img src="missing&period;png">','UNSUPPORTED_HTML_ENTITY'],
 ['entity without semicolon','index.html','<img src=&#109issing.png>','UNSUPPORTED_HTML_ENTITY'],
 ['entity in style','index.html','<div style="background:u&#114;l(missing.png)"></div>','UNSUPPORTED_HTML_ENTITY'],
] as const)test(`${label} blocks submit without draft or receipt side effects`,()=>fixture((d,run)=>{
 let a=run('create_update',{title:label},client);
 a=run('update_page',{updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId,path,content},client);
 const before=d.backup(owner);
 assert.throws(()=>run('submit_update_for_review',{updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId},client),/CHECKS_FAILED/);
 assert.equal(d.backup(owner),before);
 assert.equal(d.dispatch('get_update',{updateId:a.updateId},owner).value.state,'Draft');
 const evidence=d.dispatch('get_readiness_checks',{updateId:a.updateId},owner).value.dependencies;
 assert.equal(evidence.pass,false);assert.ok(evidence.failures.some((f:any)=>f.path===path&&f.reason===reason));
 if(reason.startsWith('UNSUPPORTED'))assert.ok(!evidence.failures.some((f:any)=>f.reason==='MISSING_DEPENDENCY'));
}));
test('new pages and changed assets publish with immutable check evidence and restore',()=>fixture((d,run,dir)=>{
 let a=run('create_update',{title:'assets'},client);const ref={updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId};
 const mutate=(op:string,args:any)=>{a=run(op,{...ref,...args},client);ref.expectedUpdateRevisionId=a.updateRevisionId;};
 mutate('create_page',{path:'about.html',content:'About',mediaType:'text/html'});
 mutate('move_page',{path:'about.html',destinationPath:'guide.html'});
 mutate('create_page',{path:'discard.html',content:'discard',mediaType:'text/html'});mutate('remove_page',{path:'discard.html'});
 mutate('update_page',{path:'styles/nested.css',content:'body {color:blue}'});
 const submitted=run('submit_update_for_review',ref);assert.equal(submitted.checksEvidence.revisionId,ref.expectedUpdateRevisionId);assert.equal(submitted.checksEvidence.pass,true);
 run('approve_update_revision',{...ref,reason:'checked'});const published=run('publish_update',{...ref,reason:'publish'});assert.deepEqual(published.checksEvidence,submitted.checksEvidence);
 const backup=d.backup(owner);const tampered=JSON.parse(backup);tampered.payload.receipts.find((r:any)=>r.value.checksEvidence).value.checksEvidence.filesDigest='0'.repeat(64);tampered.sha256=digest(JSON.stringify(tampered.payload));assert.throws(()=>Domain.restore(join(dir,'invalid'),JSON.stringify(tampered),owner,seed.manifest),/BACKUP_INVALID/);Domain.restore(join(dir,'restored'),backup,owner,seed.manifest);const restored=new Domain(join(dir,'restored'),seed);try{assert.equal(restored.current(),d.current());assert.equal(restored.file('guide.html')?.bytes.toString(),'About');assert.equal(restored.file('discard.html'),undefined);assert.equal(restored.file('styles/nested.css')?.bytes.toString(),'body {color:blue}');assert.equal(d.file('styles/nested.css','base')?.bytes.toString(),'body {color:red}');}finally{restored.close();}
}));
test('page operations reject overwrite, unsafe paths, entry removal, and unknown properties',()=>fixture((d,run)=>{
 const a=run('create_update',{title:'safe'}),ref={updateId:a.updateId,expectedUpdateRevisionId:a.updateRevisionId};
 for(const [op,args] of [['create_page',{path:'index.html',content:'overwrite',mediaType:'text/html'}],['move_page',{path:'styles/main.css',destinationPath:'styles/nested.css'}],['remove_page',{path:'index.html'}],['create_page',{path:'../escape',content:'bad',mediaType:'text/html'}],['create_page',{path:'ok.html',content:'ok',mediaType:'text/html',owner:true}] ] as const)assert.throws(()=>run(op,{...ref,...args}),/REQUEST_INVALID/);
}));
