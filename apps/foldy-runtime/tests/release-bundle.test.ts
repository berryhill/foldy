import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReleaseBundle } from '../dist/release-bundle.js';
import type { ApprovedRevision, ReleaseAdapter } from '../src/release-bundle.ts';
import { digest, loadBundle } from '../dist/bundle.js';
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'foldy-release-')); const source=join(root,'source');
 // Separate fresh source and destination, never a live runtime state directory.
 const content=Buffer.from('<h1>Approved content</h1>');
 const revision:ApprovedRevision={instanceId:'instance_test',projectId:'project_test',workbookId:'workbook_test',revisionId:'revision_test',approvedRevisionId:'revision_test',frozen:true,runtimeVersion:'0.1.0',runtimeImageDigest:'sha256:'+'a'.repeat(64),members:[{path:'index.html',mediaType:'text/html',bytes:content.length,sha256:digest(content),executableMode:0}]};
 return {root,source,content,revision};
}
import { mkdirSync } from 'node:fs';
function run(fn:(f:ReturnType<typeof fixture>,a:ReleaseAdapter)=>void){const f=fixture();mkdirSync(f.source);writeFileSync(join(f.source,'index.html'),f.content);try{fn(f,{snapshot:()=>({revision:f.revision,directory:f.source}),assertContentOnly:()=>{}});}finally{rmSync(f.root,{recursive:true,force:true});}}
test('exact manifest bytes, version binding and real loader parity',()=>run((f,a)=>{
 const css=Buffer.from('h1 { color: navy; }');writeFileSync(join(f.source,'style.css'),css);
 f.revision.members.push({path:'style.css',mediaType:'text/css',bytes:css.length,sha256:digest(css),executableMode:0});
 const first=buildReleaseBundle(a,join(f.root,'one')); f.revision.members.reverse();
 const second=buildReleaseBundle(a,join(f.root,'two'));
 assert.deepEqual(first.manifestBytes,second.manifestBytes);assert.equal(first.bundleDigest,second.bundleDigest);
 assert.deepEqual(Object.keys(first.manifest),['schemaVersion','instanceId','projectId','workbookId','revisionId','runtimeImageDigest','members']);
 const loaded=loadBundle(first.directory,first.bundleDigest);assert.deepEqual(loaded.files.get('index.html')?.bytes,f.content);
 assert.equal(JSON.parse(loaded.files.get('runtime-release.json')!.bytes.toString()).runtimeVersion,'0.1.0');
}));
for(const kind of ['unapproved','undeclared','missing','traversal','symlink','hash','executable','custody','content-secret','remote','missing-reference','adapter-denied','duplicate','unknown'] as const){test('reject '+kind,()=>run((f,a)=>{
 const file=join(f.source,'index.html');
 if(kind==='unapproved')f.revision.approvedRevisionId='other';
 if(kind==='undeclared')writeFileSync(join(f.source,'extra.txt'),'extra');
 if(kind==='missing')rmSync(file);
 if(kind==='traversal')f.revision.members[0].path='../index.html';
 if(kind==='symlink'){rmSync(file);symlinkSync('/etc/hosts',file);}
 if(kind==='hash')f.revision.members[0].sha256='b'.repeat(64);
 if(kind==='executable')chmodSync(file,0o755);
 if(kind==='custody')f.revision.members[0].path='authority.json';
 if(kind==='adapter-denied')a.assertContentOnly=()=>{throw Error('CUSTODY_REJECTED');};
 if(kind==='duplicate')f.revision.members.push({...f.revision.members[0]});
 if(kind==='unknown')Object.assign(f.revision,{ownerVerifier:'not-allowed'});
 if(['content-secret','remote','missing-reference'].includes(kind)){
  const bytes=Buffer.from(kind==='content-secret'?'ownerVerifier: synthetic-test-value':kind==='remote'?'<img src="https://example.invalid/a.png">':'<img src="missing.png">');
  writeFileSync(file,bytes);f.revision.members[0].bytes=bytes.length;f.revision.members[0].sha256=digest(bytes);
 }
 const output=join(f.root,'out');assert.throws(()=>buildReleaseBundle(a,output));assert.equal(existsSync(output),false);
}));}
