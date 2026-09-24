import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadBundle, digest, safePath } from './bundle.js';
import { Domain, draftToolNames, readToolNames, operationReceiptRequired, toolContractVersion } from './domain.js';
import { activeBundle } from './upgrade.js';
import { OwnerAuthority, protectedAncestry, type AuthorityState } from './owner-authority.js';
import { ownerUiRoute } from './owner-ui.js';
import { OperationalStatus } from './operational-status.js';
import { McpOAuth } from './mcp-oauth.js';
import { ViewerAccess } from './viewer-access.js';
import { sourceLimiter, viewerCookie, viewerRoute } from './viewer-http.js';
const required=(name:string)=>{const v=process.env[name];if(!v)throw Error('CONFIG_REQUIRED');return v;};
const opaque=()=>randomBytes(32).toString('base64url');
const protocol='2025-03-26';
async function main(){
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
 function probe(){const path=join(stateDir,`.probe-${randomUUID()}`),value=opaque();try{writeFileSync(path,value,{flag:'wx',mode:0o600});if(readFileSync(path,'utf8')!==value)throw Error('STORAGE_INVALID');}finally{if(existsSync(path))unlinkSync(path);}}
 probe();
 const domain=new Domain(join(stateDir,'content.sqlite'),bundle);
 const operations=new OperationalStatus(stateDir);
 const sessions=new Map<string,{transport:StreamableHTTPServerTransport;server:Server;grantId:string;expiresAt:number}>();
 async function closeRevokedSessions(){const active=new Set(getState()?.grants.filter(g=>g.expiresAt>Date.now()).map(g=>g.grantId));const removed=[...sessions].filter(([,s])=>!active.has(s.grantId));for(const [id]of removed)sessions.delete(id);await Promise.allSettled(removed.map(([,s])=>s.transport.close()));}
 const dev=process.env.FOLDY_DEV_LOOPBACK==='1';
 function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
 function owner(req:IncomingMessage){return authority.ownerCookie(req.headers.cookie);}
 async function body(req:IncomingMessage){let size=0;const parts:Buffer[]=[];for await(const part of req){size+=part.length;if(size>65536)throw Error('REQUEST_INVALID');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString());}
 const access=new ViewerAccess({instanceId:identity.instanceId,workbookId:identity.workbookId,directory:join(stateDir,'viewer-access'),authorizeOwner:async context=>owner(context as IncomingMessage)?{actorRef:'owner'}:null,invalidateCaches:async()=>process.env.FOLDY_EXTERNAL_CACHE_ENABLED==='0',allowSource:sourceLimiter()});
 const handler=async(req:IncomingMessage,res:ServerResponse)=>{
 const requestId=randomUUID();res.setHeader('x-request-id',requestId);
 try{
 res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
 // Static content cannot run active code or share owner privileges with scripts.
 res.setHeader('content-security-policy',"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
 const host=req.headers.host||'';if(dev&&!/^127\.0\.0\.1:\d+$/.test(host))return json(res,403,{code:'HOST_INVALID'});
 if(!dev&&host!==required('FOLDY_PUBLIC_HOST'))return json(res,403,{code:'HOST_INVALID'});
 if(req.headers.origin&&req.headers.origin!==`${dev?'http':'https'}://${host}`)return json(res,403,{code:'ORIGIN_INVALID'});
 const origin=`${dev?'http':'https'}://${host}`;
 if(await oauth.route(req,res,origin)){await closeRevokedSessions();return;}
 const path=(req.url||'').split('?')[0];if(req.url?.includes('?'))return json(res,400,{code:'REQUEST_INVALID'});
 if(ownerUiRoute(req,res,path))return;
 if(path==='/api/health'&&req.method==='GET')return json(res,200,{live:true});
 if(path==='/api/claim'&&req.method==='POST'){
 if(getState())return json(res,409,{code:'ALREADY_CLAIMED'});
 let token:string;try{token=authority.claim(await body(req));}catch{return json(res,401,{code:'AUTH_INVALID'});}
 res.setHeader('set-cookie',`__Host-foldy-owner=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200`);return json(res,200,{state:domain.requiresAccessConfiguration()?'ACCESS_CONFIGURATION_REQUIRED':'READY'});
 }
 if(path==='/api/owner/recover'||path==='/api/owner/logout'){
 if(req.method!=='POST')return json(res,405,{code:'METHOD_INVALID'});
 if(req.headers.origin!==`${dev?'http':'https'}://${host}`||!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{code:'ORIGIN_INVALID'});
 const input=await body(req);
 if(path==='/api/owner/logout'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)return json(res,400,{code:'REQUEST_INVALID'});
 authority.logout();res.setHeader('set-cookie','__Host-foldy-owner=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');return json(res,200,{loggedOut:true});
 }
 let token:string;try{token=authority.recover(input);}catch{return json(res,401,{code:'AUTH_INVALID'});}
 const revoked=[...sessions.values()];sessions.clear();
 await Promise.allSettled(revoked.map(s=>s.transport.close()));
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
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});probe();return json(res,200,{state:domain.requiresAccessConfiguration()?'ACCESS_CONFIGURATION_REQUIRED':'READY',instanceId:identity.instanceId,projectId:identity.projectId,workbookId:identity.workbookId,observedRevisionId:domain.current(),bundleDigest:bundle.bundleDigest,storage:'writable',bundle:'verified',mcp:'configured',scope:'runtime-slice-not-deployment-activation'});
 }
 if(path==='/api/owner/status'||path==='/api/owner/diagnostics'){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(req.method!=='GET')return json(res,405,{code:'METHOD_INVALID'});
 probe();const accessState=await access.status();
 const report={schemaVersion:'foldy-owner-status.v1',instanceId:identity.instanceId,projectId:identity.projectId,workbookId:identity.workbookId,runtimeVersion:'0.1.0',runtimeImageDigest:identity.runtimeImageDigest,currentPublishedRevisionId:domain.current(),storage:'writable',browserAccessMode:accessState.mode,lease:{state:'unverified'},operations:operations.snapshot(),backupMeaning:'prepared-not-download-or-restore-proof',requestId};
 if(path==='/api/owner/diagnostics')res.setHeader('content-disposition','attachment; filename="foldy-diagnostics.json"');
 return json(res,200,report);
 }
 if(path.startsWith('/api/mcp-grants')){
 if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(path==='/api/mcp-grants'&&req.method==='GET')return json(res,200,{grants:getState()!.grants.map(g=>({grantId:g.grantId,scopes:g.scopes||['foldy:read'],expiresAt:g.expiresAt,kind:g.grantId.startsWith('oauth:')?'oauth':'opaque',active:g.expiresAt>Date.now()}))});
 if(req.method!=='POST')return json(res,405,{code:'METHOD_INVALID'});
 if(path==='/api/mcp-grants'&&domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 if(!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{code:'ORIGIN_INVALID'});
 const input=await body(req);if(!owner(req))return json(res,401,{code:'AUTH_REQUIRED'});
 if(path==='/api/mcp-grants'&&input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>k==='scopes')&&(input.scopes===undefined||(Array.isArray(input.scopes)&&input.scopes.includes('foldy:read')&&input.scopes.every((s:unknown)=>s==='foldy:read'||s==='foldy:draft:write')))){const token=opaque(),grant={grantId:randomUUID(),verifier:digest(token),expiresAt:Date.now()+3600000,scopes:input.scopes||['foldy:read']};persist({...getState()!,grants:[...getState()!.grants,grant]});return json(res,201,{grantId:grant.grantId,token,scopes:grant.scopes,expiresAt:grant.expiresAt});}
 if(path==='/api/mcp-grants/revoke'&&input&&Object.keys(input).length===1&&typeof input.grantId==='string'){persist({...getState()!,grants:getState()!.grants.filter(g=>g.grantId!==input.grantId)});await closeRevokedSessions();return json(res,200,{revoked:true});}
 if(path==='/api/mcp-grants/revoke-all'&&input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===0){persist({...getState()!,grants:[]});await closeRevokedSessions();return json(res,200,{revoked:true});}
 return json(res,400,{code:'REQUEST_INVALID'});
 }
 if(!getState())return json(res,423,{code:'SEALED'});
 if(await viewerRoute(req,res,path,`${dev?'http':'https'}://${host}`,access,owner,()=>domain.confirmAccessConfiguration({id:'owner',owner:true,scopes:[]})))return;
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
 const toolSchemas=domain.tools({id:'discovery',owner:false,scopes:['foldy:read','foldy:draft:write']});
 return json(res,200,{schemaVersion:'foldy-mcp-manifest.v1',toolContractVersion,instanceId:identity.instanceId,projectId:identity.projectId,workbookId:identity.workbookId,currentPublishedRevisionId:domain.current(),serverName:'foldy-runtime',serverVersion:'0.1.0',endpoint:'/mcp',transport:dev?'HTTP loopback development only':'HTTPS Streamable HTTP',supportedProtocolVersions:[protocol],authenticationDiscovery:{mode:'oauth-authorization-code-pkce',oauth:true,protectedResourceMetadata:'/.well-known/oauth-protected-resource/mcp',authorizationServerMetadata:'/.well-known/oauth-authorization-server',fallback:'owner-issued-opaque-token'},capabilities:{tools:toolSchemas.map(t=>t.name),toolSchemas,readTools:readToolNames,draftTools:draftToolNames,scopes:['foldy:read','foldy:draft:write']},browserAccess:await access.status()});
 }
 if(path==='/mcp'){
 const authorization=req.headers.authorization;const token=authorization?.startsWith('Bearer ')?authorization.slice(7):'';const grant=getState()!.grants.find(g=>token.length<=256&&g.verifier===digest(token)&&g.expiresAt>Date.now());
 if(!grant||!oauth.accepts(grant,origin)){res.setHeader('www-authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);return json(res,401,{code:'AUTH_INVALID'});}
 if(domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 const sid=req.headers['mcp-session-id'];let session=typeof sid==='string'?sessions.get(sid):undefined;
 if(sid&&(!session||session.grantId!==grant.grantId||session.expiresAt<=Date.now()))return json(res,404,{code:'SESSION_INVALID'});
 const input=req.method==='POST'?await body(req):undefined;
 const grantCurrent=()=>getState()?.grants.some(g=>g.grantId===grant.grantId&&g.verifier===grant.verifier&&g.expiresAt>Date.now());
 if(!grantCurrent())return json(res,401,{code:'AUTH_INVALID'});
 if(!session){
 if(req.method!=='POST'||input?.method!=='initialize')return json(res,400,{code:'SESSION_INVALID'});
 if(input.params?.protocolVersion!==protocol)return json(res,400,{code:'PROTOCOL_VERSION_UNSUPPORTED'});
 const server=new Server({name:'foldy-runtime',version:'0.1.0'},{capabilities:{tools:{}}});
 const actor={id:grant.grantId,owner:false,scopes:grant.scopes||['foldy:read']};
 server.setRequestHandler(ListToolsRequestSchema,async()=>{if(!grantCurrent())throw Error('AUTH_INVALID');return {tools:domain.tools(actor)};});
 server.setRequestHandler(CallToolRequestSchema,async request=>{if(!grantCurrent())throw Error('AUTH_INVALID');return {content:[{type:'text' as const,text:JSON.stringify(domain.dispatch(request.params.name,request.params.arguments||{},actor))}]};});
 const transport:StreamableHTTPServerTransport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true,onsessioninitialized:id=>{sessions.set(id,{transport,server,grantId:grant.grantId,expiresAt:Date.now()+3600000});}});await server.connect(transport);session={transport,server,grantId:grant.grantId,expiresAt:Date.now()+3600000};
 }
 return await session.transport.handleRequest(req,res,input);
 }
 if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{code:'METHOD_INVALID'});
 if(domain.requiresAccessConfiguration())return json(res,423,{code:'ACCESS_CONFIGURATION_REQUIRED'});
 // No await/stream boundary after this decision: enqueue the verified bytes synchronously.
 if(!(await access.authorize(viewerCookie(req))).allowed)return json(res,401,{code:'ACCESS_REQUIRED'});
 const name=path==='/'?'index.html':decodeURIComponent(path.slice(1));if(!safePath(name))return json(res,400,{code:'PATH_INVALID'});const file=domain.file(name);if(!file)return json(res,404,{code:'NOT_FOUND'});
 res.writeHead(200,{'content-type':file.mediaType,'content-length':file.bytes.length});res.end(req.method==='HEAD'?undefined:file.bytes);
 }catch(error){const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'REQUEST_FAILED';if(owner(req)){try{operations.failure(requestId,'owner-request');}catch{ /* Never reveal storage errors or claim durable evidence on failure. */ }}if(!res.headersSent)json(res,400,{code,requestId});else res.end();}
 };
 const server=dev?httpServer(handler):httpsServer({key:readFileSync(required('FOLDY_TLS_KEY_FILE')),cert:readFileSync(required('FOLDY_TLS_CERT_FILE'))},handler);
 server.requestTimeout=15000;server.headersTimeout=10000;
 server.listen(Number(process.env.FOLDY_PORT||8080),dev?'127.0.0.1':'0.0.0.0',()=>{const address=server.address();if(address&&typeof address!=='string')console.log(`FOLDY_LISTENING ${address.port}`);});
}
main().catch(()=>{console.error('FOLDY_START_FAILED');process.exitCode=1;});
