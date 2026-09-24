import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
/** Revision-bound evidence; scans every member, so transitive/orphan assets cannot evade checks.
 * External dependencies fail closed until an explicit immutable-external policy is supplied.
 * Static reference extraction follows the daemon publication closure, without private imports. */
export function dependencyEvidence(files:Record<string,{content:string;mediaType:string}>,revisionId:string){
 const failures:{path:string;reference:string;reason:string}[]=[];
 const members=Object.keys(files).sort().map(path=>({path,mediaType:files[path].mediaType,sha256:digest(Buffer.from(files[path].content,'base64'))}));
 for(const {path,mediaType} of members){
 const text=Buffer.from(files[path].content,'base64').toString('utf8'),refs:string[]=[];
 // This is a bounded static extractor, not an HTML/CSS parser. Fail closed on
 // encodings it cannot interpret (including inline styles), rather than certify
 // closure or report a guessed missing path. This deliberately also rejects
 // harmless escapes/entities in prose/comments until a parser is adopted.
 if((mediaType==='text/html'||mediaType==='text/css')&&text.includes('\\')){failures.push({path,reference:'\\',reason:'UNSUPPORTED_ESCAPE'});continue;}
 if(mediaType==='text/html'&&/&(?:#|[a-z])/i.test(text)){failures.push({path,reference:'&',reason:'UNSUPPORTED_HTML_ENTITY'});continue;}
 const collect=(pattern:RegExp)=>{for(const m of text.matchAll(pattern))refs.push(m[1]||m[2]||m[3]);};
 if(mediaType==='text/html'){
 collect(/\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi);
 for(const m of text.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))for(const candidate of (m[1]??m[2]??m[3]).split(','))refs.push(candidate.trim().split(/\s+/)[0]);
 if(/<base\b/i.test(text))failures.push({path,reference:'base',reason:'UNSUPPORTED_BASE'});
 }
 if(mediaType==='text/css'||mediaType==='text/html'){
 collect(/\burl\(\s*["']?([^"')\s]+)["']?\s*\)/gi);collect(/@import\s+["']([^"']+)["']/gi);
 }
 if(/\.(?:[cm]?js|jsx)$/.test(path)||mediaType==='text/html'){
 collect(/\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?["']([^"']+)["']/g);
 collect(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g);
 }
 for(const reference of [...new Set(refs)].sort()){
 const r=reference.trim();if(!r||r.startsWith('#')||r.startsWith('data:'))continue;
 if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(r)||r.startsWith('//')){failures.push({path,reference,reason:'EXTERNAL_NOT_AUTHORIZED'});continue;}
 let decoded:string;try{decoded=decodeURIComponent(r.split(/[?#]/)[0]);}catch{failures.push({path,reference,reason:'INVALID_PATH'});continue;}
 const resolved=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(posix.dirname(path),decoded));
 if(!safePath(resolved)||decoded.includes('\\'))failures.push({path,reference,reason:'INVALID_PATH'});
 else if(!Object.hasOwn(files,resolved))failures.push({path,reference,reason:'MISSING_DEPENDENCY'});
 }
 }
 return {revisionId,filesDigest:digest(JSON.stringify(members)),pass:Object.hasOwn(files,'index.html')&&failures.length===0,failures};
}
import { exportBackup, restoreBackup, type Identity } from './recovery.js';
import { safePath, digest, policyPath, policyBytes, parsePolicy } from './bundle.js';
export type Actor={id:string;owner:boolean;scopes:string[]};
type Files=Record<string,{content:string;mediaType:string}>;
type Update={id:string;title:string;base:string;revision:string;state:string;approval?:string;comments:Comment[]};
type Comment={id:string;text:string;blocking:boolean;resolved:boolean;target:Record<string,string>;revision:string;actor:string};
const reads=['get_project','get_workbook','list_pages','get_page','list_files','get_file','search','list_updates','get_update','get_update_changes','get_update_preview','list_review_comments','get_readiness_checks','get_revision_history'];
const draft=['refresh_update_proposal','create_update','create_page','remove_page','move_page','update_page','save_update_revision','submit_update_for_review'];
const review=['add_review_comment','resolve_review_comment','request_update_changes','close_update','approve_update_revision','publish_update'];
const extras:Record<string,string[]>={refresh_update_proposal:['newPublishedBaseRevisionId'],create_page:['path','content','mediaType'],remove_page:['path'],move_page:['path','destinationPath'],create_update:['title'],update_page:['path','content'],add_review_comment:['text','blocking','target'],resolve_review_comment:['commentId','reason'],request_update_changes:['reason'],close_update:['reason'],approve_update_revision:['reason'],publish_update:['reason']};
function fail(code:string):never {throw Error(code);}
export class Domain {
 private db:DatabaseSync;
 private protectedPaths:ReadonlySet<string>;
 private identity:{instanceId:string;projectId:string;workbookId:string;revisionId:string};
 constructor(path:string,seed:{manifest:{instanceId:string;projectId:string;workbookId:string;revisionId:string};files:Map<string,{bytes:Buffer;mediaType:string}>;protectedPaths?:readonly string[]}){
 // Trusted, verified manifest/owner policy only; never accepted in tool arguments.
 const seedFiles=new Map(seed.files);
 if(seed.protectedPaths!==undefined){const bytes=policyBytes(seed.protectedPaths);if(seedFiles.has(policyPath)&&JSON.stringify(parsePolicy(seedFiles.get(policyPath)))!==JSON.stringify(parsePolicy({bytes,mediaType:'application/json'})))fail('POLICY_MISMATCH');if(!seedFiles.has(policyPath)&&seed.protectedPaths.length)seedFiles.set(policyPath,{bytes,mediaType:'application/json'});}
 const approvedPolicy=parsePolicy(seedFiles.get(policyPath));this.protectedPaths=new Set([...approvedPolicy,policyPath]);
 this.identity=seed.manifest;this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,files TEXT NOT NULL,parent TEXT,actor TEXT NOT NULL); CREATE TABLE IF NOT EXISTS updates(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,input TEXT NOT NULL,value TEXT NOT NULL);');
 const identity=JSON.stringify([seed.manifest.instanceId,seed.manifest.projectId,seed.manifest.workbookId,seed.manifest.revisionId]);
 this.db.exec('BEGIN IMMEDIATE');try{const prior=this.db.prepare('SELECT value FROM meta WHERE key=?').get('identity');if(prior&&prior.value!==identity)fail('PROJECT_MISMATCH');if(!prior){const files:Files={};for(const [p,f]of seedFiles)files[p]={content:f.bytes.toString('base64'),mediaType:f.mediaType};this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(seed.manifest.revisionId,JSON.stringify(files),null,'bootstrap');this.db.prepare('INSERT INTO meta VALUES(?,?)').run('identity',identity);this.db.prepare('INSERT INTO meta VALUES(?,?)').run('current',seed.manifest.revisionId);}
 // The immutable bootstrap revision is exported/restored with content, unlike runtime metadata.
 const baseline=this.files(seed.manifest.revisionId);
 // Backup hashes establish internal consistency, not authority. Authenticate the
 // protected baseline against the verified seed before trusting descendant equality.
 for(const p of this.protectedPaths){const trusted=seedFiles.get(p);if(baseline[p]?.content!==trusted?.bytes.toString('base64')||baseline[p]?.mediaType!==trusted?.mediaType)fail('POLICY_MISMATCH');}
 const stored=baseline[policyPath];const storedPolicy=parsePolicy(stored?{bytes:Buffer.from(stored.content,'base64'),mediaType:stored.mediaType}:undefined);
 if(JSON.stringify(storedPolicy)!==JSON.stringify(approvedPolicy)||Boolean(stored)!==seedFiles.has(policyPath))fail('POLICY_MISMATCH');
 for(const row of this.db.prepare('SELECT files FROM revisions').all()){const files=JSON.parse(row.files as string) as Files;for(const p of this.protectedPaths)if(files[p]?.content!==baseline[p]?.content||files[p]?.mediaType!==baseline[p]?.mediaType)fail('POLICY_MISMATCH');}
 this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');this.db.close();throw e;}
 }
 /** Persisted fail-closed recovery gate; transport handlers must enforce it. */
 requiresAccessConfiguration(){return this.db.prepare('SELECT value FROM meta WHERE key=?').get('recovery_access_required')?.value==='1';}
 /** Trusted handler only: call AFTER successful explicit ViewerAccess.configure.
  * Actor must come from authenticated custody, never request arguments. */
 confirmAccessConfiguration(actor:Actor){
 if(!actor?.owner)fail('OWNER_REQUIRED');this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM meta WHERE key=?').run('recovery_access_required');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 backup(actor:Actor){return exportBackup(this.db,actor);}
 static restore(path:string,backup:string,actor:Actor,expectedIdentity:Identity){return restoreBackup(path,backup,actor,expectedIdentity);}
 close(){this.db.close();}
 current(){return this.db.prepare('SELECT value FROM meta WHERE key=?').get('current')!.value as string;}
 private files(revision:string):Files{const r=this.db.prepare('SELECT files FROM revisions WHERE id=?').get(revision);if(!r)fail('REVISION_CONFLICT');return JSON.parse(r.files as string);}
 file(path:string,revision=this.current()){if(!safePath(path))fail('REQUEST_INVALID');const f=this.files(revision)[path];return f?{bytes:Buffer.from(f.content,'base64'),mediaType:f.mediaType}:undefined;}
 tools(actor:Actor){return [...reads,...(actor.owner||actor.scopes.includes('foldy:draft:write')?draft:[]),...(actor.owner?review:[])].map(name=>{const keys=reads.includes(name)?['projectId','atRevisionId',...(['get_update','get_update_changes','get_update_preview','list_review_comments','get_readiness_checks'].includes(name)?['updateId']:[]),...(['get_file','get_page'].includes(name)?['path']:[]),...(name==='search'?['query']:[])]:['projectId','expectedBaseRevisionId','idempotencyKey',...(name==='create_update'?[]:['updateId','expectedUpdateRevisionId']),...(extras[name]||[])];const required=reads.includes(name)?keys.filter(k=>!['projectId','atRevisionId'].includes(k)):keys;return {name,description:name.replaceAll('_',' '),inputSchema:{type:'object' as const,properties:Object.fromEntries(keys.map(k=>[k,k==='blocking'?{type:'boolean'}:k==='target'?{type:'object',properties:Object.fromEntries(['path','block','field','selection'].map(p=>[p,{type:'string'}])),additionalProperties:false}:{type:'string'}])),required,additionalProperties:false}};});}
 dispatch(name:string,args:Record<string,unknown>,actor:Actor):any{
 if(!actor.owner&&!actor.scopes.includes('foldy:read'))fail('SCOPE_REQUIRED');const tool=this.tools(actor).find(t=>t.name===name);if(!tool)fail('SCOPE_REQUIRED');
 if(!args||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k))||tool.inputSchema.required.some(k=>args[k]===undefined))fail('REQUEST_INVALID');
 for(const [k,v]of Object.entries(args)){if(k==='blocking'){if(typeof v!=='boolean')fail('REQUEST_INVALID');}else if(k==='target'){if(!v||typeof v!=='object'||Array.isArray(v)||Object.entries(v).some(([p,x])=>!['path','block','field','selection'].includes(p)||typeof x!=='string'||x.length>2048))fail('REQUEST_INVALID');}else if(typeof v!=='string'||!v.length||v.length>(k==='content'?60000:2048))fail('REQUEST_INVALID');}
 if(args.projectId!==undefined&&args.projectId!==this.identity.projectId)fail('PROJECT_MISMATCH');
 if(reads.includes(name))return this.read(name,args);
 this.db.exec('BEGIN IMMEDIATE');try{
 const key=actor.id+':'+args.idempotencyKey,input=digest(JSON.stringify([name,Object.fromEntries(Object.entries(args).sort(([a],[b])=>a.localeCompare(b)))]));const old=this.db.prepare('SELECT input,value FROM receipts WHERE key=?').get(key);if(old){if(old.input!==input)fail('IDEMPOTENCY_CONFLICT');this.db.exec('COMMIT');return JSON.parse(old.value as string);}
 // Closing abandons this exact proposal; it never advances publication and need not refresh conflicting content.
 const current=this.current();if(name!=='close_update'&&(name==='refresh_update_proposal'?args.newPublishedBaseRevisionId:args.expectedBaseRevisionId)!==current)fail('REVISION_CONFLICT');let u:Update;let priorState:string|null=null;let commentId:string|undefined;
 if(name==='create_update'){u={id:randomUUID(),title:args.title as string,base:current,revision:randomUUID(),state:'Draft',comments:[]};this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(u.revision,JSON.stringify(this.files(current)),current,actor.id);}else{u=this.update(args.updateId as string);priorState=u.state;if(u.base!==args.expectedBaseRevisionId||u.revision!==args.expectedUpdateRevisionId)fail('REVISION_CONFLICT');if(['Closed','Published'].includes(u.state))fail('UPDATE_CLOSED');}
 let refreshEvidence:Record<string,string>|undefined;
 if(name==='refresh_update_proposal'){
 if(u.base===current)fail('REVISION_CONFLICT');
 const before=this.files(u.base),proposal=this.files(u.revision),published=this.files(current),merged:Files={...published};
 const equal=(a:Files[string]|undefined,b:Files[string]|undefined)=>a?.content===b?.content&&a?.mediaType===b?.mediaType;
 const conflicts:{path:string}[]=[];
 for(const path of [...new Set([...Object.keys(before),...Object.keys(proposal),...Object.keys(published)])].sort()){
 if(equal(before[path],proposal[path]))continue;
 if(!equal(before[path],published[path])&&!equal(proposal[path],published[path])){conflicts.push({path});continue;}
 if(this.protectedPaths.has(path)&&!equal(proposal[path],published[path]))fail('PROTECTED_PATH');
 if(proposal[path])merged[path]=proposal[path];else delete merged[path];
 }
 if(conflicts.length){this.db.exec('ROLLBACK');return {code:'REFRESH_CONFLICT',conflicts,updateId:u.id,updateRevisionId:u.revision,currentPublishedRevisionId:current};}
 refreshEvidence={previousBaseRevisionId:u.base,previousUpdateRevisionId:u.revision};
 const revision=randomUUID();this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(revision,JSON.stringify(merged),u.revision,actor.id);u.revision=revision;u.base=current;u.state='Draft';delete u.approval;
 }
 if(['create_page','remove_page','move_page','update_page'].includes(name)&&[args.path,args.destinationPath].some(p=>typeof p==='string'&&this.protectedPaths.has(p)))fail('PROTECTED_PATH');
 if(['create_page','remove_page','move_page','update_page','save_update_revision'].includes(name)){const files=this.files(u.revision);
 if(['create_page','remove_page','move_page'].includes(name)){const p=args.path as string;if(!safePath(p)||['__proto__','constructor','prototype','manifest.json'].includes(p))fail('REQUEST_INVALID');
 if(name==='create_page'){if(Object.hasOwn(files,p)||!['text/html','text/css','text/plain','application/json'].includes(args.mediaType as string))fail('REQUEST_INVALID');files[p]={content:Buffer.from(args.content as string).toString('base64'),mediaType:args.mediaType as string};}
 else {if(p==='index.html'||!Object.hasOwn(files,p))fail('REQUEST_INVALID');if(name==='move_page'){const dest=args.destinationPath as string;if(!safePath(dest)||['__proto__','constructor','prototype','manifest.json'].includes(dest)||Object.hasOwn(files,dest))fail('REQUEST_INVALID');files[dest]=files[p];}delete files[p];}}if(name==='update_page'){const p=args.path as string;if(!safePath(p)||!files[p]||!['text/html','text/css','text/plain','application/json'].includes(files[p].mediaType))fail('REQUEST_INVALID');files[p]={...files[p],content:Buffer.from(args.content as string).toString('base64')};}const revision=randomUUID();this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(revision,JSON.stringify(files),u.revision,actor.id);u.revision=revision;u.state='Draft';}
 if(name==='submit_update_for_review'){if(!['Draft','Changes requested'].includes(u.state))fail('REVIEW_REQUIRED');this.check(u);u.state='Ready for review';}
 if(name==='add_review_comment'){const target=args.target as Record<string,string>;if(target.path&&!this.files(u.revision)[target.path])fail('REQUEST_INVALID');commentId=randomUUID();u.comments.push({id:commentId,text:args.text as string,blocking:args.blocking as boolean,resolved:false,target,revision:u.revision,actor:actor.id});if(args.blocking){u.state='Changes requested';delete u.approval;}}
 if(name==='resolve_review_comment'){const c=u.comments.find(c=>c.id===args.commentId);if(!c)fail('REQUEST_INVALID');c.resolved=true;}
 if(name==='request_update_changes'){u.state='Changes requested';delete u.approval;}
 if(name==='approve_update_revision'){this.check(u);if(!['Ready for review','Changes requested'].includes(u.state))fail('REVIEW_REQUIRED');u.approval=u.revision;u.state='Approved';}
 if(name==='publish_update'){if(u.approval&&u.approval!==u.revision)fail('APPROVAL_STALE');if(u.state!=='Approved'||u.approval!==u.revision)fail('REVIEW_REQUIRED');this.check(u);const changed=this.db.prepare('UPDATE meta SET value=? WHERE key=? AND value=?').run(u.revision,'current',u.base);if(changed.changes!==1)fail('REVISION_CONFLICT');u.state='Published';}
 if(name==='close_update')u.state='Closed';this.db.prepare('INSERT INTO updates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(u.id,JSON.stringify(u));
 const checksEvidence=['submit_update_for_review','approve_update_revision','publish_update'].includes(name)?dependencyEvidence(this.files(u.revision),u.revision):undefined;
 const result={...(refreshEvidence?{refreshEvidence}:{}),...(checksEvidence?{checksEvidence}:{}),projectId:this.identity.projectId,updateId:u.id,priorState,currentState:u.state,updateRevisionId:u.revision,currentPublishedRevisionId:this.current(),receiptId:randomUUID(),occurredAt:new Date().toISOString(),actorRef:actor.id,operation:name,reason:args.reason||null,...(commentId?{commentId}:{})};this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(key,input,JSON.stringify(result));this.db.exec('COMMIT');return result;
 }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 private update(id:string):Update{const row=this.db.prepare('SELECT value FROM updates WHERE id=?').get(id);if(!row)fail('UPDATE_UNAVAILABLE');return JSON.parse(row.value as string);}
 private check(u:Update){const base=this.files(u.base),proposal=this.files(u.revision);for(const p of this.protectedPaths)if(base[p]?.content!==proposal[p]?.content||base[p]?.mediaType!==proposal[p]?.mediaType)fail('PROTECTED_PATH');if(u.comments.some(c=>c.blocking&&!c.resolved))fail('BLOCKING_COMMENTS');if(!dependencyEvidence(this.files(u.revision),u.revision).pass)fail('CHECKS_FAILED');}
 private read(name:string,args:Record<string,unknown>){const observedRevisionId=(args.atRevisionId as string)||this.current(),files=this.files(observedRevisionId);if(['list_updates','get_revision_history'].includes(name)&&observedRevisionId!==this.current())fail('REVISION_CONFLICT');let value:unknown;
 if(name==='get_project')value={instanceId:this.identity.instanceId,projectId:this.identity.projectId,workbookId:this.identity.workbookId};
 if(name==='get_workbook'){const f=files['workbook.json'];if(!f||f.mediaType!=='application/json')fail('FILE_UNAVAILABLE');value={path:'workbook.json',content:Buffer.from(f.content,'base64').toString('utf8')};}
 if(name==='list_pages')value=Object.keys(files).filter(path=>files[path].mediaType==='text/html').sort();
 if(name==='get_page'){const path=args.path as string,f=files[path];if(!safePath(path)||!f||f.mediaType!=='text/html')fail('FILE_UNAVAILABLE');value={path,content:Buffer.from(f.content,'base64').toString('utf8')};}
 if(name==='list_files')value=Object.entries(files).map(([path,f])=>({path,mediaType:f.mediaType,bytes:Buffer.from(f.content,'base64').length,sha256:digest(Buffer.from(f.content,'base64'))}));
 if(name==='get_file'){const f=files[args.path as string];if(!f)fail('FILE_UNAVAILABLE');value={path:args.path,encoding:'base64',bytes:f.content,mediaType:f.mediaType};}
 if(name==='search'){const query=(args.query as string).toLocaleLowerCase(),matches:{path:string;excerpt:string}[]=[];for(const path of Object.keys(files).sort()){const f=files[path];if(!['text/html','text/plain','text/css','application/json'].includes(f.mediaType))continue;const content=Buffer.from(f.content,'base64').toString('utf8'),position=content.toLocaleLowerCase().indexOf(query);if(position<0)continue;matches.push({path,excerpt:content.slice(Math.max(0,position-60),position+query.length+120)});if(matches.length===50)break;}value=matches;}
 if(name==='list_updates')value=this.db.prepare('SELECT value FROM updates').all().map(r=>JSON.parse(r.value as string));
 if(name==='get_revision_history')value=this.db.prepare('SELECT id,parent,actor FROM revisions').all();
 if(args.updateId){const u=this.update(args.updateId as string);if(args.atRevisionId&&u.revision!==args.atRevisionId)fail('REVISION_CONFLICT');if(name==='get_update')value={...u,decisions:this.db.prepare("SELECT value FROM receipts WHERE json_extract(value,'$.updateId')=? AND json_extract(value,'$.operation') IN ('request_update_changes','close_update','approve_update_revision','publish_update') ORDER BY rowid").all(u.id).map(r=>JSON.parse(r.value as string)).map(r=>({receiptId:r.receiptId,operation:r.operation,reason:r.reason,actorRef:r.actorRef,occurredAt:r.occurredAt,updateRevisionId:r.updateRevisionId,currentState:r.currentState}))};if(name==='list_review_comments')value=u.comments;if(name==='get_update_preview')value={revisionId:u.revision,files:this.files(u.revision)};if(name==='get_readiness_checks')value={revisionId:u.revision,blockingComments:u.comments.filter(c=>c.blocking&&!c.resolved).length,baseCurrent:u.base===this.current(),approved:u.approval===u.revision,entryPresent:!!this.files(u.revision)['index.html'],dependencies:dependencyEvidence(this.files(u.revision),u.revision)};if(name==='get_update_changes'){const before=this.files(u.base),after=this.files(u.revision);value=[...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(p=>before[p]?.content!==after[p]?.content||before[p]?.mediaType!==after[p]?.mediaType).map(path=>({path,before:before[path],after:after[path]}));}}
 return {observedRevisionId:args.updateId?this.update(args.updateId as string).revision:observedRevisionId,value};
 }
}
