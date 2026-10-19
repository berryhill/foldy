import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { clientUiRoute } from '../dist/client-ui.js';

test('public connection guide has direct links and truthful owner entry without private metadata', async () => {
 const server=createServer((req,res)=>{clientUiRoute(req,res,new URL(req.url||'/', 'http://localhost').pathname);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const address=server.address();assert.ok(address && typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  const response=await fetch(origin+'/connect');assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/href="https:\/\/chatgpt\.com\/plugins"/);
  assert.match(html,/href="https:\/\/developers\.openai\.com\/api\/docs\/guides\/secure-mcp-tunnels"/);
  assert.match(html,/href="\/owner\/setup"/);assert.match(html,/separately delivered one-use key/);assert.match(html,/generic setup URL alone grants no access/);
  assert.doesNotMatch(html,/not available here yet|tunnel_[0-9a-f]{32}/);
  const script=await (await fetch(origin+'/connect/app.js')).text();new Function(script);
  assert.match(script,/Copy invitation setup URL/);
  assert.match(script,/new URL\('\/owner\/setup',location\.origin\)\.href/);
  assert.match(script,/clearPrivate\(\)/);
 }finally{server.close();await once(server,'close');}
});
