import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { loadBundle, digest, safePath } from './bundle.js';
import { Domain, draftToolNames, readToolNames, operationReceiptRequired, toolContractVersion } from './domain.js';
import { activeBundle } from './upgrade.js';
import { OwnerAuthority, protectedAncestry, type AuthorityState } from './owner-authority.js';
import { ownerUiRoute } from './owner-ui.js';
import { OperationalStatus } from './operational-status.js';
import { McpOAuth } from './mcp-oauth.js';
import { ViewerAccess } from './viewer-access.js';
import { sourceLimiter, viewerCookie, viewerRoute } from './viewer-http.js';
import { ingressConfig, requestOrigin } from './ingress.js';
import { grantEvidence, tunnelBinding } from './connect.js';
import { clientUiRoute } from './client-ui.js';
const required=(name:string)=>{const v=process.env[name];if(!v)throw Error('CONFIG_REQUIRED');return v;};
const opaque=()=>randomBytes(32).toString('base64url');
// SDK owns initialize validation and version negotiation. Discovery must list
// exactly the same versions rather than a separately maintained allowlist.
async function main(){
 const ingress=ingressConfig(process.env);
 const tunnel=tunnelBinding(process.env.FOLDY_SECURE_MCP_TUNNEL_BINDING_FILE);
 const initial={directory:required('FOLDY_BUNDLE_DIR'),digest:required('FOLDY_BUNDLE_DIGEST')};
 const stateDir=resolve(required('FOLDY_STATE_DIR'));mkdirSync(stateDir,{recursive:true,mode:0o700});if(lstatSync(stateDir).isSymbolicLink())throw Error('STATE_INVALID');
 protectedAncestry(stateDir);
 const bundleRoot=resolve(required('FOLDY_BUNDLE_DIR'));
 if(stateDir===bundleRoot||stateDir.startsWith(bundleRoot+'/'))throw Error('STATE_INVALID');
 const lockPath=join(stateDir,'runtime.lock');const lock=openSync(lockPath,'wx',0o600);closeSync(lock);
 process.once('exit',()=>{try{unlinkSync(lockPath);}catch{ /* Preserve fail-closed startup. */ }});
 process.once('SIGTERM',()=>process.exit(0));process.once('SIGINT',()=>process.exit(0));
 const {bundle,authorityBundleDigest}=activeBundle(stateDir,initial);const identity=bundle.manifest;
 const authority=new OwnerAuthority({directory:stateDir,instanceId:identity.instanceId,bundleDigest:authorityBundleDigest,bootstrapFile:process.env.FOLDY_BOOTSTRAP_FILE,recoveryFile:process.env.FOLDY_OWNER_RECOVERY_FILE,rejectBundleVerifier:value=>[...bundle.files.values()].some(f=>f.bytes.includes(value))});
 const oauth=new McpOAuth(authority,identity.instanceId);
 const getState=()=>authority.state;
 function persist(next:AuthorityState){authority.persist(next);}
 function recordToolSuccess(grantId:string,name:string){
  const state=getState(),current=state?.grants.find(g=>g.grantId===grantId&&g.expiresAt>Date.now());
  if(!state||!current)throw Error('AUTH_INVALID');
  const at=Date.now();
  const evidence=readToolNames.includes(name)?{lastSuccessfulReadAt:at}:draftToolNames.includes(name)?{lastSuccessfulDraftAt:at}:null;
  if(evidence)persist({...state,grants:state.grants.map(g=>g.grantId===grantId?{...g,...evidence}:g)});
 }
 function probe(){const path=join(stateDir,`.probe-${randomUUID()}`),value=opaque();try{writeFileSync(path,value,{flag:'wx',mode:0o600});if(readFileSync(path,'utf8')!==value)throw Error('STORAGE_INVALID');}finally{if(existsSync(path))unlinkSync(path);}}
 probe();
 const domain=new Domain(join(stateDir,'content.sqlite'),bundle);
 const operations=new OperationalStatus(stateDir);
 const sessions=new Map<string,{transport:StreamableHTTPServerTransport;server:Server;grantId:string;expiresAt:number}>();
 const requests=new Map<string,{until:number;count:number}>();
 let pendingSessions=0;
 const pendingByGrant=new Map<string,number>();
 async function cleanSessions(){
  const now=Date.now(),active=new Set(getState()?.grants.filter(g=>g.expiresAt>now).map(g=>g.grantId));
  const removed=[...sessions].filter(([,s])=>s.expiresAt<=now||!active.has(s.grantId));
  for(const [id] of removed)sessions.delete(id);
  for(const [id,b] of requests)if(b.until<=now||id!=='*'&&!active.has(id))requests.delete(id);
  await Promise.allSettled(removed.map(([,s])=>s.transport.close()));
 }
 setInterval(()=>{void cleanSessions();},60000).unref();
 function requestAllowed(id:string){
  const now=Date.now();
  for(const [key,limit] of [[id,60],['*',512]] as const){
   const b=requests.get(key);
   if(b&&b.until>now&&b.count>=limit)return false;
  }
  for(const key of [id,'*']){let b=requests.get(key);if(!b||b.until<=now){b={until:now+60000,count:0};requests.set(key,b);}b.count++;}
  return true;
 }
 const dev=ingress.mode==='dev';
 function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
 function owner(req:IncomingMessage){return authority.ownerCookie(req.headers.cookie);}
 async function body(req:IncomingMessage,limit=65536){let size=0;const parts:Buffer[]=[];for await(const part of req){size+=part.length;if(size>limit)throw Error('REQUEST_INVALID');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString());}
 const access=new ViewerAccess({instanceId:identity.instanceId,workbookId:identity.workbookId,directory:join(stateDir,'viewer-access'),authorizeOwner:async context=>owner(context as IncomingMessage)?{actorRef:'owner'}:null,invalidateCaches:async()=>process.env.FOLDY_EXTERNAL_CACHE_ENABLED==='0',allowSource:sourceLimiter()});
 // Bound distinct guesses by transport peer, never a forwarded header. Owner
 // grant revocation remains independent of this login budget.
 const ownerAttemptKey=randomBytes(32),allowOwnerAttempt=sourceLimiter(Date.now,1024,5,true),allowOwnerSource=sourceLimiter(Date.now,1024,8);
 const handler=async(req:IncomingMessage,res:ServerResponse)=>{
 const requestId=randomUUID();res.setHeader('x-request-id',requestId);
 try{
 res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
 // Static content cannot run active code or share owner privileges with scripts.
 res.setHeader('content-security-policy',"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
 const origin=requestOrigin(ingress,req.headers.host);
 if(!origin)return json(res,403,{code:'HOST_INVALID'});
 if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{code:'ORIGIN_INVALID'});
 if(await oauth.route(req,res,origin)){await cleanSessions();return;}
 const path=(req.url||'').split('?')[0];if(req.url?.includes('?'))return json(res,400,{code:'REQUEST_INVALID'});
 if(ownerUiRoute(req,res,path))return;
 if(path==='/connect'||path==='/connect/app.js'){clientUiRoute(req,res,path);return;}
 if(path==='/api/health'&&req.method==='GET')return json(res,200,{live:true});
 if(path==='/api/connect'&&req.method==='GET')return json(res,200,{schemaVersion:'foldy-connect.v1',transport:tunnel?'configured-not-verified':'unconfigured',chatgptReady:false,authentication:'oauth-authorization-code-pkce',endpointPath:'/mcp'});
 if(path==='/api/connect/status'||path==='/api/connect/tunnel'){
  if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
  if(req.method!=='GET')return json(res,405,{code:'METHOD_INVALID'});
  if(path==='/api/connect/tunnel')return json(res,200,{schemaVersion:'foldy-secure-mcp-tunnel-status.v1',state:tunnel?'configured-not-verified':'unconfigured',tunnelId:tunnel?.tunnelId||null,onlineVerified:false});
  return json(res,200,{schemaVersion:'foldy-connect-status.v1',transport:tunnel?'configured-not-verified':'unconfigured',chatgptReady:false,grants:getState()?.grants.map(g=>grantEvidence(g))||[]});
 }
 if(path==='/'){
  const state=getState()?domain.requiresAccessConfiguration()?'unavailable':(await access.authorize(viewerCookie(req))).allowed?'allowed':'locked':'unavailable';
  clientUiRoute(req,res,path,state);return;
 }
 if(path==='/api/owner/access'&&req.method==='GET')return json(res,200,{claimed:!!getState(),passwordConfigured:!!getState()?.ownerPassword});
 if(path==='/api/claim'&&req.method==='POST'){
 if(getState())return json(res,409,{code:'ALREADY_CLAIMED'});
 if((req.headers.origin&&req.headers.origin!==origin)||!req.headers['content-type']?.startsWith('application/json')||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))return json(res,403,{code:'ORIGIN_INVALID'});
 let token:string;try{token=await authority.claimWithPassword(await body(req,4096));}catch{return json(res,401,{code:'AUTH_INVALID'});}
 res.setHeader('set-cookie',`__Host-foldy-owner=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200`);return json(res,200,{state:domain.requiresAccessConfiguration()?'ACCESS_CONFIGURATION_REQUIRED':'READY'});
 }
 if(path==='/api/owner/login'){
 if(req.method!=='POST')return json(res,405,{code:'METHOD_INVALID'});
 if((req.headers.origin&&req.headers.origin!==origin)||!req.headers['content-type']?.startsWith('application/json')||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))return json(res,403,{code:'ORIGIN_INVALID'});
 const input=await body(req,4096);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.password!=='string')return json(res,401,{code:'AUTH_INVALID'});
 const candidate=createHmac('sha256',ownerAttemptKey).update(input.password).digest('hex');
 if(!req.socket.remoteAddress||!await allowOwnerSource(req.socket.remoteAddress)||!await allowOwnerAttempt(req.socket.remoteAddress+':'+candidate))return json(res,429,{code:'RATE_LIMITED'});
 let token:string;try{token=await authority.login(input);}catch{return json(res,401,{code:'AUTH_INVALID'});}
 res.setHeader('set-cookie',`__Host-foldy-owner=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200`);return json(res,200,{authenticated:true});
 }
 if(path==='/api/owner/password'){
 if(req.method!=='POST')return json(res,405,{code:'METHOD_INVALID'});
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{code:'ORIGIN_INVALID'});
 const input=await body(req,4096);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.password!=='string')return json(res,400,{code:'REQUEST_INVALID'});
 let token:string;try{token=await authority.setPassword(req.headers.cookie,input.password);}catch{return json(res,401,{code:'AUTH_INVALID'});}
 res.setHeader('set-cookie',`__Host-foldy-owner=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200`);
 return json(res,200,{configured:true});
 }
 if(path==='/api/owner/recover'||path==='/api/owner/logout'){
 if(req.method!=='POST')return json(res,405,{code:'METHOD_INVALID'});
 if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{code:'ORIGIN_INVALID'});
 const input=await body(req);
 if(path==='/api/owner/logout'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)return json(res,400,{code:'REQUEST_INVALID'});
 authority.logout();res.setHeader('set-cookie','__Host-foldy-owner=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');return json(res,200,{loggedOut:true});
 }
 let token:string;try{token=await authority.recoverWithPassword(input);}catch{return json(res,401,{code:'AUTH_INVALID'});}
 await cleanSessions();
 res.setHeader('set-cookie',`__Host-foldy-owner=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200`);return json(res,200,{recovered:true});
 }
 if(path==='/api/backup'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(req.method!=='GET')return json(res,405,{code:'METHOD_INVALID'});
 if(domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 let backup:string;try{backup=domain.backup({id:'owner',owner:true,scopes:[]});operations.backupPrepared(domain.current(),Buffer.byteLength(backup));}catch{operations.failure(requestId,'backup');return json(res,400,{code:'BACKUP_FAILED',requestId});}
 res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="foldy-backup.json"','cache-control':'no-store','content-length':Buffer.byteLength(backup)});res.end(backup);return;
 }
 if(path==='/api/readiness'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});probe();return json(res,200,{state:domain.requiresAccessConfiguration()?'ACCESS_CONFIGURATION_REQUIRED':'READY',ownerPasswordConfigured:!!getState()?.ownerPassword,instanceId:identity.instanceId,projectId:identity.projectId,workbookId:identity.workbookId,observedRevisionId:domain.current(),bundleDigest:bundle.bundleDigest,storage:'writable',bundle:'verified',mcp:'configured',scope:'runtime-slice-not-deployment-activation'});
 }
 if(path==='/api/owner/status'||path==='/api/owner/diagnostics'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(req.method!=='GET')return json(res,405,{code:'METHOD_INVALID'});
 probe();const accessState=await access.status();
 const report={schemaVersion:'foldy-owner-status.v1',instanceId:identity.instanceId,projectId:identity.projectId,workbookId:identity.workbookId,runtimeVersion:'0.1.0',runtimeImageDigest:identity.runtimeImageDigest,currentPublishedRevisionId:domain.current(),storage:'writable',browserAccessMode:accessState.mode,ownerPasswordConfigured:!!getState()?.ownerPassword,lease:{state:'unverified'},operations:operations.snapshot(),backupMeaning:'prepared-not-download-or-restore-proof',requestId};
 if(path==='/api/owner/diagnostics')res.setHeader('content-disposition','attachment; filename="foldy-diagnostics.json"');
 return json(res,200,report);
 }
 if(path.startsWith('/api/mcp-grants')){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(path==='/api/mcp-grants'&&req.method==='GET')return json(res,200,{grants:getState()!.grants.map(g=>grantEvidence(g))});
 if(req.method!=='POST')return json(res,405,{code:'METHOD_INVALID'});
 if(path==='/api/mcp-grants'&&domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 if(!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{code:'ORIGIN_INVALID'});
 const input=await body(req);if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(path==='/api/mcp-grants'&&input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>k==='scopes')&&(input.scopes===undefined||(Array.isArray(input.scopes)&&input.scopes.includes('foldy:read')&&input.scopes.every((s:unknown)=>s==='foldy:read'||s==='foldy:draft:write')))){const token=opaque(),grant={grantId:randomUUID(),verifier:digest(token),expiresAt:Date.now()+3600000,scopes:input.scopes||['foldy:read']};persist({...getState()!,grants:[...getState()!.grants,grant]});return json(res,201,{grantId:grant.grantId,token,scopes:grant.scopes,expiresAt:grant.expiresAt});}
 if(path==='/api/mcp-grants/revoke'&&input&&Object.keys(input).length===1&&typeof input.grantId==='string'){persist({...getState()!,grants:getState()!.grants.filter(g=>g.grantId!==input.grantId)});await cleanSessions();return json(res,200,{revoked:true});}
 if(path==='/api/mcp-grants/revoke-all'&&input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===0){persist({...getState()!,grants:[]});await cleanSessions();return json(res,200,{revoked:true});}
 return json(res,400,{code:'REQUEST_INVALID'});
 }
 if(!getState())return json(res,423,{code:'SEALED'});
 if(path.startsWith('/_preview/')){
  if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{code:'METHOD_INVALID'});
  if(domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
  const match=/^\/_preview\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)\/(.*)$/.exec(path);
  if(!match||/%(?:2f|5c|00)/i.test(match[3]))return json(res,400,{code:'PATH_INVALID'});
  let name:string;try{name=decodeURIComponent(match[3]||'index.html');}catch{return json(res,400,{code:'PATH_INVALID'});}
  const file=domain.previewFile(match[1],match[2],name);
  res.setHeader('x-foldy-preview-revision',file.revisionId);
  res.writeHead(200,{'content-type':file.mediaType,'content-length':file.bytes.length});
  res.end(req.method==='HEAD'?undefined:file.bytes);return;
 }
 if(await viewerRoute(req,res,path,origin,access,owner,()=>domain.confirmAccessConfiguration({id:'owner',owner:true,scopes:[]})))return;
 if(path==='/api/operations/contract'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(req.method!=='GET')return json(res,405,{code:'METHOD_INVALID'});
 return json(res,200,{schemaVersion:toolContractVersion,request:{name:'string',arguments:'inputSchema of named tool'},readTools:readToolNames,readResponseRequired:['observedRevisionId','value'],receiptRequired:operationReceiptRequired,tools:domain.tools({id:'owner',owner:true,scopes:[]})});
 }
if(path==='/api/operations'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(req.method!=='POST')return json(res,405,{code:'METHOD_INVALID'});
 if(domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 const input=await body(req);if(!input||Object.keys(input).some(k=>!['name','arguments'].includes(k))||typeof input.name!=='string'||!input.arguments||typeof input.arguments!=='object')return json(res,400,{code:'REQUEST_INVALID'});
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 return json(res,200,domain.dispatch(input.name,input.arguments,{id:'owner',owner:true,scopes:[]}));
 }
 if(path==='/mcp/manifest.json'&&req.method==='GET'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 const toolSchemas=domain.tools({id:'discovery',owner:false,scopes:['foldy:read','foldy:draft:write']});
 return json(res,200,{schemaVersion:'foldy-mcp-manifest.v1',toolContractVersion,instanceId:identity.instanceId,projectId:identity.projectId,workbookId:identity.workbookId,currentPublishedRevisionId:domain.current(),serverName:'foldy-runtime',serverVersion:'0.1.0',endpoint:'/mcp',transport:dev?'HTTP loopback development only':'HTTPS Streamable HTTP',supportedProtocolVersions:[...SUPPORTED_PROTOCOL_VERSIONS],authenticationDiscovery:{mode:'oauth-authorization-code-pkce',oauth:true,protectedResourceMetadata:'/.well-known/oauth-protected-resource/mcp',authorizationServerMetadata:'/.well-known/oauth-authorization-server',fallback:'owner-issued-opaque-token'},capabilities:{tools:toolSchemas.map(t=>t.name),toolSchemas,readTools:readToolNames,draftTools:draftToolNames,scopes:['foldy:read','foldy:draft:write']},browserAccess:await access.status()});
 }
 if(path==='/mcp'){
 await cleanSessions();
 const authorization=req.headers.authorization;const token=authorization?.startsWith('Bearer ')?authorization.slice(7):'';const grant=getState()!.grants.find(g=>token.length<=256&&g.verifier===digest(token)&&g.expiresAt>Date.now());
 if(!grant||!oauth.accepts(grant,origin)){res.setHeader('www-authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);return json(res,401,{code:'AUTH_INVALID'});}
 if(domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 const sid=req.headers['mcp-session-id'];let session=typeof sid==='string'?sessions.get(sid):undefined;
 if(sid&&(!session||session.grantId!==grant.grantId||session.expiresAt<=Date.now()))return json(res,404,{code:'SESSION_INVALID'});
 if(!requestAllowed(grant.grantId))return json(res,429,{code:'RATE_LIMITED'});
 const input=req.method==='POST'?await body(req):undefined;
 const grantCurrent=()=>getState()?.grants.some(g=>g.grantId===grant.grantId&&g.verifier===grant.verifier&&g.expiresAt>Date.now());
 if(!grantCurrent())return json(res,401,{code:'AUTH_INVALID'});
 if(!session){
 if(req.method!=='POST'||input?.method!=='initialize')return json(res,400,{code:'SESSION_INVALID'});
 if(sessions.size+pendingSessions>=32||[...sessions.values()].filter(s=>s.grantId===grant.grantId).length+(pendingByGrant.get(grant.grantId)||0)>=8)return json(res,429,{code:'SESSION_LIMITED'});
 pendingSessions++;pendingByGrant.set(grant.grantId,(pendingByGrant.get(grant.grantId)||0)+1);
 try{
 const server=new Server({name:'foldy-runtime',version:'0.1.0'},{capabilities:{tools:{}}});
 const actor={id:grant.grantId,owner:false,scopes:grant.scopes||['foldy:read']};
 server.setRequestHandler(ListToolsRequestSchema,async()=>{if(!grantCurrent())throw Error('AUTH_INVALID');return {tools:domain.tools(actor)};});
 server.setRequestHandler(CallToolRequestSchema,async request=>{if(!grantCurrent())throw Error('AUTH_INVALID');const result=domain.dispatch(request.params.name,request.params.arguments||{},actor);if(!result?.code)recordToolSuccess(grant.grantId,request.params.name);return {content:[{type:'text' as const,text:JSON.stringify(result)}]};});
 const transport:StreamableHTTPServerTransport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true,onsessioninitialized:id=>{if(grantCurrent())sessions.set(id,{transport,server,grantId:grant.grantId,expiresAt:Math.min(grant.expiresAt,Date.now()+3600000)});},onsessionclosed:id=>{sessions.delete(id);}});
 await server.connect(transport);
 return await transport.handleRequest(req,res,input);
 }finally{pendingSessions--;const remaining=(pendingByGrant.get(grant.grantId)||1)-1;if(remaining)pendingByGrant.set(grant.grantId,remaining);else pendingByGrant.delete(grant.grantId);}
 }
 return await session.transport.handleRequest(req,res,input);
 }
 if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{code:'METHOD_INVALID'});
 if(domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 // No await/stream boundary after this decision: enqueue the verified bytes synchronously.
 if(!(await access.authorize(viewerCookie(req))).allowed)return json(res,401,{code:'ACCESS_REQUIRED'});
 const documentRoute=path.startsWith('/_document/');
 let name:string;try{name=decodeURIComponent(documentRoute?path.slice('/_document/'.length):path.slice(1));}catch{return json(res,400,{code:'PATH_INVALID'});}
 if(documentRoute&&!name)name='index.html';
 if(!safePath(name))return json(res,400,{code:'PATH_INVALID'});const file=domain.file(name);if(!file)return json(res,404,{code:'NOT_FOUND'});
 if(documentRoute&&file.mediaType==='text/html')res.setHeader('content-security-policy',"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
 res.writeHead(200,{'content-type':file.mediaType,'content-length':file.bytes.length});res.end(req.method==='HEAD'?undefined:file.bytes);
 }catch(error){const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'REQUEST_FAILED';if(owner(req)){try{operations.failure(requestId,'owner-request');}catch{ /* Never reveal storage errors or claim durable evidence on failure. */ }}if(!res.headersSent)json(res,400,{code,requestId});else res.end();}
 };
 const server=ingress.mode==='direct'?httpsServer({key:readFileSync(required('FOLDY_TLS_KEY_FILE')),cert:readFileSync(required('FOLDY_TLS_CERT_FILE'))},handler):httpServer(handler);
 server.requestTimeout=15000;server.headersTimeout=10000;
 server.listen(Number(process.env.FOLDY_PORT||8080),ingress.bind,()=>{const address=server.address();if(address&&typeof address!=='string')console.log(`FOLDY_LISTENING ${address.port}`);});
}
main().catch(()=>{console.error('FOLDY_START_FAILED');process.exitCode=1;});
