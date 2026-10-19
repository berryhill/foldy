import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedHealth, checkedRuntimeStatus, localHealthUrl, operatorTransport, parseRequest, type TransportRequest, type Runner } from '../dist/operator-transport.js';
import type { ProcessProbe } from '../dist/transport-observation.js';
import { transportStatus, tunnelBinding } from '../dist/connect.js';

const id='tunnel_0123456789abcdef0123456789abcdef';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'foldy-transport-')), privateDir=join(root,'operator');mkdirSync(privateDir,{mode:0o700});
 const file=(name:string)=>join(privateDir,name);
 const request:TransportRequest={schemaVersion:'foldy-operator-transport.v1',tunnelId:id,alias:'foldy',profile:'foldy',clientExecutable:file('tunnel-client'),profileDir:privateDir,homeDir:privateDir,xdgConfigDir:file('config'),xdgStateDir:file('state'),runtimeKeyFile:file('key'),mcpUrl:'https://foldy.example/mcp',bindingFile:file('binding'),evidenceFile:file('evidence'),healthUrlFile:file('health-url'),pidFile:file('pid')};
 mkdirSync(request.xdgConfigDir,{mode:0o700});mkdirSync(request.xdgStateDir,{mode:0o700});
 writeFileSync(request.runtimeKeyFile,'synthetic-key-do-not-use',{mode:0o600});
 writeFileSync(request.clientExecutable,'synthetic-not-executed',{mode:0o700});
 writeFileSync(join(request.xdgStateDir,'native-health-url'),'http://127.0.0.1:34567/',{mode:0o644});
 writeFileSync(request.healthUrlFile,'http://127.0.0.1:34567/',{mode:0o600});writeFileSync(request.pidFile,'321',{mode:0o600});
 const requestFile=file('request');
 const save=()=>writeFileSync(requestFile,JSON.stringify(request),{mode:0o600});save();
 return {root,request,requestFile,save};
}
function health(r:TransportRequest,now:number){return {locator:{kind:'url_file',resolved_base_url:'http://127.0.0.1:34567/'},process:{pid:321,pid_file:r.pidFile,running:true},healthz:{ok:true},readyz:{ok:true},control_plane_poll:{ok:true,value:(now-1000)/1000},result:'ok'};}
const processProbe:ProcessProbe=pid=>pid===321?{pid,startTime:'12345',executable:'/fixture/tunnel-client-runtime'}:null;
function managed(r:TransportRequest){return {alias:r.alias,tunnel_id:r.tunnelId,profile_name:r.profile,profile_dir:r.profileDir,process_running:true,stale:false,remote_lookup_attempted:true,remote_error:'',remote:{},health_url:'http://127.0.0.1:34567',health_url_file:join(r.xdgStateDir,'native-health-url'),process:{alias:r.alias,tunnel_id:r.tunnelId,profile_name:r.profile,profile_dir:r.profileDir,pid:321,target_value:r.mcpUrl,health_url_file:join(r.xdgStateDir,'native-health-url')}};}

test('protected request and exact schema reject untrusted paths and identities without mutation',async()=>{
 const f=fixture();try{
  assert.equal(parseRequest(f.requestFile).tunnelId,id);
  let called=false;const runner:Runner=()=>{called=true;return {status:0,stdout:''};};
  assert.equal(await operatorTransport('dry-run',f.requestFile,runner),null);assert.equal(called,false);
  assert.throws(()=>readFileSync(f.request.bindingFile));
  for(const invalid of [{...f.request,tunnelId:'tunnel_placeholder'},{...f.request,extra:'x'},{...f.request,mcpUrl:'http://foldy.example/mcp'},{...f.request,mcpUrl:'https://user@foldy.example/mcp'},{...f.request,mcpUrl:'https://foldy.example/mcp?x=1'},{...f.request,alias:'../other'}]){
   writeFileSync(f.requestFile,JSON.stringify(invalid));await assert.rejects(operatorTransport('dry-run',f.requestFile,runner),/TRANSPORT_INPUT_INVALID/);
  }
  assert.equal(called,false);
  f.save();chmodSync(f.requestFile,0o644);assert.throws(()=>parseRequest(f.requestFile),/TRANSPORT_INPUT_INVALID/);
  chmodSync(f.requestFile,0o600);chmodSync(f.request.runtimeKeyFile,0o644);assert.throws(()=>parseRequest(f.requestFile),/TRANSPORT_INPUT_INVALID/);chmodSync(f.request.runtimeKeyFile,0o600);
  symlinkSync(f.requestFile,join(f.root,'symlink'));
  assert.throws(()=>parseRequest(join(f.root,'symlink')),/TRANSPORT_INPUT_INVALID/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('configure calls exact installed CLI contract, never exposes key bytes, and status is bound to health evidence',async()=>{
 const f=fixture(),now=1_800_000_000_000,calls:string[][]=[];
 const runner:Runner=(args,env,executable)=>{calls.push(args);assert.equal(env.HOME,f.request.homeDir);assert.equal(env.XDG_CONFIG_HOME,f.request.xdgConfigDir);assert.equal(env.TUNNEL_CLIENT_STATE_DIR,join(f.request.xdgStateDir,'tunnel-client'));assert.equal(env.OPENAI_ADMIN_KEY,undefined);assert.equal(executable,f.request.clientExecutable);return {status:0,stdout:args[1]==='status'?JSON.stringify(managed(f.request)):JSON.stringify({})};};
 try{
  await operatorTransport('configure',f.requestFile,runner,now);
  assert.deepEqual(calls,[['init','--sample','sample_mcp_with_dcr','--profile-dir',f.request.profileDir,'--profile','foldy','--tunnel-id',id,'--mcp-server-url',f.request.mcpUrl,'--control-plane-api-key-ref',`file:${f.request.runtimeKeyFile}`,'--health-listen-addr','127.0.0.1:0'],['doctor','--profile-dir',f.request.profileDir,'--profile','foldy','--explain']]);
  assert.ok(!JSON.stringify(calls).includes('synthetic-key-do-not-use'));
  assert.equal(tunnelBinding(f.request.bindingFile)?.alias,'foldy');
  const evidence=await operatorTransport('start',f.requestFile,runner,now,{processProbe,healthProbe:async()=>health(f.request,now)});
  assert.equal(evidence?.state,'ready-poll-confirmed');
  assert.equal(calls[2]?.join(' '),['runtimes','connect','--alias','foldy','--tunnel-id',id,'--profile-dir',f.request.profileDir,'--profile','foldy','--runtime-api-key',`file:${f.request.runtimeKeyFile}`,'--mcp-server-url',f.request.mcpUrl].join(' '));
  assert.deepEqual(calls[3],['runtimes','status','foldy','--json']);
  assert.equal(calls.length,4,'health uses fixed no-redirect loopback probes, not the redirect-following vendor health command');
  const binding=tunnelBinding(f.request.bindingFile);
  assert.equal(transportStatus(binding,now,processProbe).state,'ready-poll-confirmed');
  assert.equal(transportStatus(binding,now+90001,processProbe).state,'configured-not-verified');
  assert.equal(transportStatus({...binding!,tunnelId:'tunnel_ffffffffffffffffffffffffffffffff'},now,processProbe).state,'configured-not-verified');
  assert.equal(transportStatus(binding,now,()=>null).state,'configured-not-verified');
  assert.equal(transportStatus(binding,now,pid=>({...processProbe(pid)!,startTime:'reused'})).state,'configured-not-verified');
  assert.ok(!readFileSync(f.request.evidenceFile,'utf8').includes('synthetic-key-do-not-use'));
  assert.equal((await operatorTransport('status',f.requestFile,runner,now+1000,{processProbe,healthProbe:async()=>health(f.request,now)}))?.state,'ready-poll-confirmed');
  await assert.rejects(operatorTransport('status',f.requestFile,()=>({status:1,stdout:'private diagnostic must not escape'}),now),/TRANSPORT_UNREADY/);
  assert.equal(transportStatus(binding,now,processProbe).state,'configured-not-verified');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('malformed identity fails closed and stale or absent poll never becomes ready',async()=>{
 const f=fixture(),now=1_800_000_000_000;try{
  const good=health(f.request,now);
  assert.equal(checkedHealth(good,f.request,now,processProbe).state,'ready-poll-confirmed');
  for(const bad of [{...good,result:'fail'},{...good,control_plane_poll:undefined},{...good,control_plane_poll:{ok:true,value:(now+6000)/1000}},{...good,process:{...good.process,pid:322}},{...good,locator:{...good.locator,resolved_base_url:'http://other.example/'}}])assert.throws(()=>checkedHealth(bad,f.request,now,processProbe),/TRANSPORT_UNREADY/);
  for(const pending of [{...good,readyz:{ok:false}},{...good,control_plane_poll:{ok:false,value:0}},{...good,control_plane_poll:{ok:true,value:(now-91000)/1000}}])assert.equal(checkedHealth(pending,f.request,now,processProbe).state,'healthy');
  for(const url of ['http://127.0.0.1:34567/other','http://127.0.0.1:34567/?x=1','http://localhost:34567/','http://user@127.0.0.1:34567/','https://127.0.0.1:34567/','http://8.8.8.8:34567/'])assert.equal(localHealthUrl(url),false,url);
  assert.equal(localHealthUrl('http://127.0.0.1:34567/'),true);
  let calls=0;const denied:Runner=()=>{calls++;return {status:1,stdout:'sensitive diagnostic ignored'};};
  await assert.rejects(operatorTransport('configure',f.requestFile,denied,now),/TRANSPORT_COMMAND_FAILED/);
  assert.equal(calls,1);assert.throws(()=>readFileSync(f.request.bindingFile));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('native status must match alias, tunnel, profile, target and live PID',()=>{
 const f=fixture();try{
  const good=managed(f.request);assert.equal(checkedRuntimeStatus(good,f.request,processProbe).pid,321);
  for(const bad of [{...good,alias:'different'},{...good,tunnel_id:'tunnel_ffffffffffffffffffffffffffffffff'},{...good,profile_name:'different'},{...good,process_running:false},{...good,stale:true},{...good,remote_error:'denied'},{...good,remote_lookup_attempted:false},{...good,health_url:'http://external.invalid/'},{...good,process:{...good.process,target_value:'https://other.example/mcp'}},{...good,process:{...good.process,pid:322}}])assert.throws(()=>checkedRuntimeStatus(bad,f.request,processProbe));
  assert.throws(()=>checkedRuntimeStatus(good,f.request,()=>null),/TRANSPORT_PROCESS_UNVERIFIED/);
  chmodSync(join(f.request.xdgStateDir,'native-health-url'),0o666);assert.throws(()=>checkedRuntimeStatus(good,f.request,processProbe));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
