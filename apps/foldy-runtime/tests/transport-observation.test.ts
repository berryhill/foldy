import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loopbackHealth } from '../dist/operator-transport.js';
import { liveTransportProcess, validObservation } from '../dist/transport-observation.js';

async function listen(server:ReturnType<typeof createServer>){server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}/`;}
async function close(server:ReturnType<typeof createServer>){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}

test('health uses only bounded fixed loopback routes and observes a real metrics response',async()=>{
 const paths:string[]=[];
 const server=createServer((req,res)=>{paths.push(req.url||'');res.writeHead(200);res.end(req.url==='/metrics'?`commands_poll_last_successful_timestamp_seconds ${Date.now()/1000}\n`:'live');});
 try{
  const url=await listen(server);const report=await loopbackHealth(url) as Record<string,any>;
  assert.deepEqual(paths.sort(),['/healthz','/metrics','/readyz']);assert.equal(report.healthz.ok,true);assert.equal(report.readyz.ok,true);assert.equal(report.control_plane_poll.ok,true);
  await assert.rejects(loopbackHealth(url+'outside'),/TRANSPORT_UNREADY/);
 }finally{await close(server);}
});

test('a loopback redirect is rejected without following it to a second origin',async()=>{
 let redirectedHits=0;
 const destination=createServer((_,res)=>{redirectedHits++;res.end('must not be read');});
 const target=await listen(destination);
 const source=createServer((_,res)=>{res.writeHead(302,{location:target});res.end();});
 try{const url=await listen(source);await assert.rejects(loopbackHealth(url));assert.equal(redirectedHits,0);}
 finally{await close(source);await close(destination);}
});

test('oversized and duplicate metrics cannot produce positive poll evidence',async()=>{
 let oversized=true;
 const server=createServer((req,res)=>{res.writeHead(200);res.end(req.url==='/metrics'?(oversized?'x'.repeat(70000):'commands_poll_last_successful_timestamp_seconds 1\ncommands_poll_last_successful_timestamp_seconds 2\n'):'live');});
 try{
  const url=await listen(server);await assert.rejects(loopbackHealth(url),/TRANSPORT_UNREADY/);oversized=false;
  const report=await loopbackHealth(url) as Record<string,any>;assert.equal(report.control_plane_poll.ok,false);assert.equal(report.control_plane_poll.value,0);
 }finally{await close(server);}
});

test('process identity, restart and observation age are independently required',()=>{
 const now=Date.now(),identity={pid:321,startTime:'123',executable:'/fixture/tunnel-client-runtime'};
 const evidence={schemaVersion:'foldy-transport-evidence.v2',tunnelId:'tunnel_0123456789abcdef0123456789abcdef',alias:'foldy',...identity,observedAt:now,pollAt:now,state:'ready-poll-confirmed'};
 assert.equal(validObservation(evidence,evidence.tunnelId,'foldy',now,()=>identity)?.state,'ready-poll-confirmed');
 assert.equal(validObservation(evidence,evidence.tunnelId,'foldy',now,()=>null),null);
 assert.equal(validObservation(evidence,evidence.tunnelId,'foldy',now,()=>({...identity,startTime:'124'})),null);
 assert.equal(validObservation(evidence,evidence.tunnelId,'foldy',now+90001,()=>identity),null);
 assert.equal(validObservation({...evidence,pollAt:0},evidence.tunnelId,'foldy',now,()=>identity),null);
 assert.equal(liveTransportProcess(0),null);assert.equal(liveTransportProcess(process.pid),null,'the Node test process is not a tunnel client');
});
