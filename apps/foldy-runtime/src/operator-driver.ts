import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { protectedAncestry } from './owner-authority.js';
import { liveTransportProcess, observationAgeMs, futureSkewMs, type ProcessProbe, type TransportObservation, type TransportProcess } from './transport-observation.js';

const fail=(code:string):never=>{throw Error(code);};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const absolute=(v:unknown):v is string=>typeof v==='string'&&isAbsolute(v)&&resolve(v)===v;
const namePattern=/^[a-z][a-z0-9-]{0,62}$/;
function openPrivate(path:string,maxBytes:number){
 let fd:number|undefined;
 try{
  if(!absolute(path))return fail('TRANSPORT_INPUT_INVALID');
  protectedAncestry(dirname(path),true);fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)||stat.size<1||stat.size>maxBytes)return fail('TRANSPORT_INPUT_INVALID');
  return fd;
 }catch{if(fd!==undefined)closeSync(fd);return fail('TRANSPORT_INPUT_INVALID');}
}
export function privateFile(path:string,maxBytes=4096){const fd=openPrivate(path,maxBytes);try{return readFileSync(fd,'utf8');}finally{closeSync(fd);}}
function assertPrivateFile(path:string,maxBytes=4096){const fd=openPrivate(path,maxBytes);closeSync(fd);}
/** Vendor-generated health locator is metadata inside the selected private state root. */
function nativeHealthLocator(path:string){
 protectedAncestry(dirname(path));const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o022)||stat.size<1||stat.size>256)return fail('TRANSPORT_IDENTITY_MISMATCH');return readFileSync(fd,'utf8');}
 finally{closeSync(fd);}
}
function outputPath(path:string){
 if(!absolute(path))return fail('TRANSPORT_INPUT_INVALID');
 protectedAncestry(dirname(path),true);
 try{const stat=lstatSync(path);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077))return fail('TRANSPORT_INPUT_INVALID');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return fail('TRANSPORT_INPUT_INVALID');}
}
function executablePath(path:string){
 if(!absolute(path))return fail('TRANSPORT_INPUT_INVALID');
 protectedAncestry(dirname(path));
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||(s.uid!==0&&s.uid!==process.getuid?.())||(s.mode&0o022)||!(s.mode&0o111))return fail('TRANSPORT_INPUT_INVALID');}finally{closeSync(fd);}
}
export type TransportRequest={
 schemaVersion:'foldy-operator-transport.v1';tunnelId:string;alias:string;profile:string;clientExecutable:string;
 profileDir:string;homeDir:string;xdgConfigDir:string;xdgStateDir:string;runtimeKeyFile:string;mcpUrl:string;
 bindingFile:string;evidenceFile:string;healthUrlFile:string;pidFile:string;
};
export function parseRequest(path:string):TransportRequest{
 try{
  const v:unknown=JSON.parse(privateFile(path,16384));
  const keys=['schemaVersion','tunnelId','alias','profile','clientExecutable','profileDir','homeDir','xdgConfigDir','xdgStateDir','runtimeKeyFile','mcpUrl','bindingFile','evidenceFile','healthUrlFile','pidFile'];
  if(!object(v)||Object.keys(v).sort().join(',')!==keys.sort().join(',')||v.schemaVersion!=='foldy-operator-transport.v1'||typeof v.tunnelId!=='string'||!/^tunnel_[a-f0-9]{32}$/.test(v.tunnelId)||typeof v.alias!=='string'||!namePattern.test(v.alias)||typeof v.profile!=='string'||!namePattern.test(v.profile))return fail('TRANSPORT_INPUT_INVALID');
  for(const key of ['clientExecutable','profileDir','homeDir','xdgConfigDir','xdgStateDir','runtimeKeyFile','bindingFile','evidenceFile','healthUrlFile','pidFile'])if(!absolute(v[key]))return fail('TRANSPORT_INPUT_INVALID');
  if(typeof v.mcpUrl!=='string')return fail('TRANSPORT_INPUT_INVALID');
  const url=new URL(v.mcpUrl);
  if(url.protocol!=='https:'||url.pathname!=='/mcp'||url.username||url.password||url.search||url.hash||url.href!==v.mcpUrl||!url.hostname)return fail('TRANSPORT_INPUT_INVALID');
  const r=v as TransportRequest;
  const files=[path,r.clientExecutable,r.runtimeKeyFile,r.bindingFile,r.evidenceFile,r.healthUrlFile,r.pidFile];
  if(new Set(files).size!==files.length)return fail('TRANSPORT_INPUT_INVALID');
  const roots=[r.profileDir,r.homeDir,r.xdgConfigDir,r.xdgStateDir];
  for(const root of roots){protectedAncestry(root,true);if(files.includes(root))return fail('TRANSPORT_INPUT_INVALID');}
  if(dirname(r.bindingFile)!==dirname(r.evidenceFile))return fail('TRANSPORT_INPUT_INVALID');
  for(const target of [r.bindingFile,r.evidenceFile,r.healthUrlFile,r.pidFile])outputPath(target);
  assertPrivateFile(r.runtimeKeyFile); // Metadata only: the native client resolves the key.
  executablePath(r.clientExecutable);
  return r;
 }catch{return fail('TRANSPORT_INPUT_INVALID');}
}
function savePrivate(path:string,text:string){
 outputPath(path);const temporary=join(dirname(path),`.foldy-transport-${process.pid}-${randomUUID()}`);let created=false;
 try{
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
  try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);created=false;
  const directory=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{fsyncSync(directory);}finally{closeSync(directory);}
 }catch{if(created){try{unlinkSync(temporary);}catch{ /* Only an unissued generated temporary file. */ }}return fail('TRANSPORT_WRITE_FAILED');}
}
export function writePrivate(path:string,value:unknown){savePrivate(path,JSON.stringify(value)+'\n');}
export function canonicalHealthUrl(value:string):string|null{
 try{
  const u=new URL(value);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||Number(u.port)<1||u.pathname!=='/'||u.username||u.password||u.search||u.hash||![u.origin,u.origin+'/'].includes(value))return null;
  return u.origin+'/';
 }catch{return null;}
}
export const localHealthUrl=(value:string)=>canonicalHealthUrl(value)!==null;
export type ManagedRuntime={pid:number;url:string;identity:TransportProcess};
export function checkedRuntimeStatus(value:unknown,r:TransportRequest,probe:ProcessProbe=liveTransportProcess):ManagedRuntime{
 if(!object(value)||value.alias!==r.alias||value.tunnel_id!==r.tunnelId||value.profile_name!==r.profile||value.profile_dir!==r.profileDir||value.process_running!==true||value.stale!==false||value.remote_lookup_attempted!==true||value.remote_error!==''||!object(value.remote)||!object(value.process))return fail('TRANSPORT_IDENTITY_MISMATCH');
 const p=value.process;
 if(p.alias!==r.alias||p.tunnel_id!==r.tunnelId||p.profile_name!==r.profile||p.profile_dir!==r.profileDir||p.target_value!==r.mcpUrl||!Number.isSafeInteger(p.pid)||Number(p.pid)<1)return fail('TRANSPORT_IDENTITY_MISMATCH');
 if(typeof value.health_url!=='string'||typeof value.health_url_file!=='string'||p.health_url_file!==value.health_url_file||!absolute(value.health_url_file)||!value.health_url_file.startsWith(r.xdgStateDir+sep)||[r.runtimeKeyFile,r.clientExecutable,r.bindingFile,r.evidenceFile,r.pidFile].includes(value.health_url_file))return fail('TRANSPORT_IDENTITY_MISMATCH');
 const url=canonicalHealthUrl(value.health_url),recorded=canonicalHealthUrl(nativeHealthLocator(value.health_url_file).trim());
 if(!url||recorded!==url)return fail('TRANSPORT_IDENTITY_MISMATCH');
 const identity=probe(Number(p.pid));
 if(!identity||identity.pid!==p.pid)return fail('TRANSPORT_PROCESS_UNVERIFIED');
 return {pid:Number(p.pid),url,identity};
}
export type Runner=(args:string[],env:NodeJS.ProcessEnv,executable:string)=>{status:number|null;stdout:string};
export const nativeRunner:Runner=(args,env,executable)=>{
 const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:args[0]==='runtimes'&&args[1]==='status'?15000:120000,maxBuffer:65536,stdio:['ignore','pipe','ignore']});
 return {status:result.status,stdout:result.stdout||''};
};
export type HealthProbe=(url:string)=>Promise<unknown>;
async function boundedResponse(url:string){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(3000),headers:{accept:'application/json, text/plain'}});
 if(!response.body)return {status:response.status,text:''};
 const reader=response.body.getReader();let size=0;const parts:Uint8Array[]=[];
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536)return fail('TRANSPORT_UNREADY');parts.push(next.value);}}
 finally{await reader.cancel();}
 return {status:response.status,text:Buffer.concat(parts).toString('utf8')};
}
/** Fixed loopback routes only; unlike the vendor health CLI, redirects are rejected. */
export const loopbackHealth:HealthProbe=async(raw)=>{
 const url=canonicalHealthUrl(raw);if(!url)return fail('TRANSPORT_UNREADY');
 const [health,ready,metrics]=await Promise.all(['healthz','readyz','metrics'].map(path=>boundedResponse(url+path)));
 const matches=metrics.text.match(/^commands_poll_last_successful_timestamp_seconds\s+([0-9.eE+-]+)\s*$/gm)||[];
 const poll=matches.length===1?Number(matches[0].trim().split(/\s+/)[1]):0;
 return {locator:{resolved_base_url:url},healthz:{ok:health.status===200},readyz:{ok:ready.status===200},control_plane_poll:{ok:metrics.status===200&&Number.isFinite(poll)&&poll>0,value:poll},result:health.status===200?'ok':'fail'};
};
export function checkedHealth(value:unknown,r:TransportRequest,now=Date.now(),probe:ProcessProbe=liveTransportProcess):TransportObservation{
 if(!object(value)||value.result!=='ok'||!object(value.locator)||!object(value.process)||!object(value.healthz)||!object(value.readyz)||!object(value.control_plane_poll)||value.healthz.ok!==true||value.process.running!==true)return fail('TRANSPORT_UNREADY');
 const pid=value.process.pid;
 if(!Number.isSafeInteger(pid)||Number(pid)<1||Number(privateFile(r.pidFile,64).trim())!==pid||value.process.pid_file!==r.pidFile)return fail('TRANSPORT_UNREADY');
 const identity=probe(Number(pid)),url=canonicalHealthUrl(privateFile(r.healthUrlFile,256).trim());
 if(!identity||identity.pid!==pid||!url||value.locator.resolved_base_url!==url)return fail('TRANSPORT_UNREADY');
 const poll=Number(value.control_plane_poll.value),pollAt=Number.isFinite(poll)&&poll>0?Math.round(poll*1000):0;
 if(pollAt>now+futureSkewMs)return fail('TRANSPORT_UNREADY');
 const ready=value.readyz.ok===true&&value.control_plane_poll.ok===true&&pollAt>0&&now-pollAt<=observationAgeMs;
 return {schemaVersion:'foldy-transport-evidence.v2',tunnelId:r.tunnelId,alias:r.alias,...identity,observedAt:now,pollAt:ready?pollAt:0,state:ready?'ready-poll-confirmed':'healthy'};
}
export type DriverDependencies={processProbe?:ProcessProbe;healthProbe?:HealthProbe};
export async function operatorTransport(operation:'dry-run'|'configure'|'start'|'status',requestPath:string,runner:Runner=nativeRunner,now?:number,dependencies:DriverDependencies={}):Promise<TransportObservation|null>{
 const r=parseRequest(requestPath);if(operation==='dry-run')return null;
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:r.homeDir,XDG_CONFIG_HOME:r.xdgConfigDir,XDG_STATE_HOME:r.xdgStateDir,TUNNEL_CLIENT_STATE_DIR:join(r.xdgStateDir,'tunnel-client')};
 const run=(args:string[])=>{const result=runner(args,env,r.clientExecutable);if(result.status!==0||result.stdout.length>65536)return fail('TRANSPORT_COMMAND_FAILED');return result.stdout;};
 // Invalidate before any command which could fail, including start/configure.
 writePrivate(r.evidenceFile,{schemaVersion:'foldy-transport-evidence.v2',state:'unready'});
 if(operation==='configure'){
  run(['init','--sample','sample_mcp_with_dcr','--profile-dir',r.profileDir,'--profile',r.profile,'--tunnel-id',r.tunnelId,'--mcp-server-url',r.mcpUrl,'--control-plane-api-key-ref',`file:${r.runtimeKeyFile}`,'--health-listen-addr','127.0.0.1:0']);
  run(['doctor','--profile-dir',r.profileDir,'--profile',r.profile,'--explain']);
  writePrivate(r.bindingFile,{schemaVersion:'foldy-secure-mcp-tunnel.v2',tunnelId:r.tunnelId,credentialFile:r.runtimeKeyFile,evidenceFile:r.evidenceFile,alias:r.alias});return null;
 }
 try{
  if(operation==='start')run(['runtimes','connect','--alias',r.alias,'--tunnel-id',r.tunnelId,'--profile-dir',r.profileDir,'--profile',r.profile,'--runtime-api-key',`file:${r.runtimeKeyFile}`,'--mcp-server-url',r.mcpUrl]);
  const probe=dependencies.processProbe||liveTransportProcess;
  const managed=checkedRuntimeStatus(JSON.parse(run(['runtimes','status',r.alias,'--json'])),r,probe);
  savePrivate(r.healthUrlFile,managed.url+'\n');savePrivate(r.pidFile,String(managed.pid)+'\n');
  const value=await(dependencies.healthProbe||loopbackHealth)(managed.url);
  if(!object(value))return fail('TRANSPORT_UNREADY');
  const evidence=checkedHealth({...value,process:{pid:managed.pid,pid_file:r.pidFile,running:true}},r,now??Date.now(),probe);
  if(evidence.startTime!==managed.identity.startTime||evidence.executable!==managed.identity.executable)return fail('TRANSPORT_PROCESS_UNVERIFIED');
  writePrivate(r.evidenceFile,evidence);return evidence;
 }catch{return fail('TRANSPORT_UNREADY');}
}
