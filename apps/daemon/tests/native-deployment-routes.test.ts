import express from 'express';
import { afterEach, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { serviceSetup } from './helpers/native-deployment.js';
import { cleanup } from './helpers/native-cynder.js';
import { createBrowserPasswordAccess, registerBrowserPasswordAccessRoutes } from '../src/foldy-access/browser-password.js';
import { registerNativeDeploymentRoutes, nativeDeploymentOwner } from '../src/routes/foldy-native-deployment.js';
import { NativeDeploymentService } from '../src/foldy-deployments/native-deployment-service.js';
import { NativeCynderConsumer } from '../src/foldy-deployments/native-cynder.js';
import type { Request } from 'express';
import type { NativeDeploymentPrepareResponse } from '@open-design/contracts';
afterEach(cleanup);
test('real session guard, fail-closed configuration, exact receipt, replay and substitution', async () => {
 const s = await serviceSetup(); const access = await createBrowserPasswordAccess({ dataRoot: s.dir });
 const password = randomBytes(24).toString('hex'); await access.configure(password);
 s.admission.ownerPrincipalId = 'local-admin'; s.admission.bootstrap.ownerPrincipalId = 'local-admin';
 const service = new NativeDeploymentService<Request>({ consumer: new NativeCynderConsumer(s.config), dataRoot: s.dir, origin: s.config.origin, requireOwner: async req => nativeDeploymentOwner(access, req), resolveAdmission: async () => s.admission });
 const app = express(); registerBrowserPasswordAccessRoutes(app, access); app.use(express.json()); registerNativeDeploymentRoutes(app, { access, service });
 const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
 const base = 'http://127.0.0.1:' + (server.address() as {port:number}).port;
 const post = (path: string, body: unknown, cookie = '', origin = base) => fetch(base + path, {method:'POST', headers:{'content-type':'application/json', cookie, origin}, body:JSON.stringify(body)});
 const root = '/api/foldy/native-deployments';
 try {
  expect((await post(root+'/prepare',s.request)).status).toBe(401); await expect(s.calls()).rejects.toThrow();
  const login = async () => (await post('/api/foldy-access/unlock',{password})).headers.get('set-cookie')!.split(';')[0]!;
  const cookie = await login(), other = await login();
  expect((await post(root+'/prepare',s.request,cookie,'https://evil.example')).status).toBe(403); await expect(s.calls()).rejects.toThrow();
  expect((await post(root+'/prepare',{...s.request, admission:s.admission},cookie)).status).toBe(400); await expect(s.calls()).rejects.toThrow();
  const prepared = await post(root+'/prepare',s.request,cookie); expect(prepared.status).toBe(200); const q = await prepared.json() as NativeDeploymentPrepareResponse;
  const approval = {approvalReceipt:q.approvalReceipt,csrf:q.csrf};
  expect((await post(root+'/execute',approval,other)).status).toBe(403);
  expect((await post(root+'/execute',{...approval,operationId:'a'.repeat(64)},cookie)).status).toBe(400);
  expect((await post(root+'/execute',{...approval,csrf:'wrong'},cookie)).status).toBe(403);
  expect((await s.calls()).length).toBe(2); await s.mode('settled');
  expect((await post(root+'/execute',approval,cookie)).status).toBe(200);
  expect((await post(root+'/execute',approval,cookie)).status).toBe(403);
  expect((await fetch(base+root+'/'+q.result.operationId,{headers:{cookie}})).status).toBe(200);
  expect((await post(root+'/'+q.result.operationId+'/reconcile',{},cookie)).status).toBe(200);
 } finally { await new Promise<void>((r,j)=>server.close(e=>e?j(e):r())); }
});
test('missing resolver fails before prepare consumer', async () => {
 const s = await serviceSetup(); const service = new NativeDeploymentService({consumer:new NativeCynderConsumer(s.config), dataRoot:s.dir, origin:s.config.origin, requireOwner:async()=>({principalId:'owner-1',sessionId:'session-1'})});
 await expect(service.prepare(null,s.request)).rejects.toThrow('FOLDY_HOSTING_NOT_CONFIGURED'); await expect(s.calls()).rejects.toThrow();
});
