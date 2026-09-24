import express from 'express';
import { afterEach, expect, test } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { serviceSetup } from './helpers/native-deployment.js';
import { cleanup } from './helpers/native-cynder.js';
import { createBrowserPasswordAccess, registerBrowserPasswordAccessRoutes } from '../src/foldy-access/browser-password.js';
import { registerNativeDeploymentRoutes, nativeDeploymentOwner } from '../src/routes/foldy-native-deployment.js';
import { NativeDeploymentService } from '../src/foldy-deployments/native-deployment-service.js';
import { NativeCynderConsumer } from '../src/foldy-deployments/native-cynder.js';
import type { Request } from 'express';
import type { NativeDeploymentPrepareResponse } from '@open-design/contracts';
afterEach(cleanup);
test('injected owner resolver rejects viewer access and binds exact approval receipts', async () => {
 const s = await serviceSetup(); const access = await createBrowserPasswordAccess({ dataRoot: s.dir });
 const password = randomBytes(24).toString('hex'); await access.configure(password);
 const ownerCookie = 'foldy_test_owner=' + randomBytes(32).toString('hex');
 const otherOwnerCookie = 'foldy_test_owner=' + randomBytes(32).toString('hex');
 const resolveOwner = async (req: Request) => {
   const token = /(?:^|;\s*)foldy_test_owner=([a-f0-9]{64})(?:;|$)/.exec(req.get('cookie') ?? '')?.[1];
   if (!token) throw new Error('FOLDY_OWNER_DENIED');
   return { principalId: 'owner-1', sessionId: createHash('sha256').update(token).digest('hex') };
 };
 s.admission.ownerPrincipalId = 'owner-1'; s.admission.bootstrap.ownerPrincipalId = 'owner-1';
 const service = new NativeDeploymentService<Request>({ consumer: new NativeCynderConsumer(s.config), dataRoot: s.dir, origin: s.config.origin, requireOwner: req => nativeDeploymentOwner(access, req, resolveOwner), resolveAdmission: async () => s.admission });
 const app = express(); registerBrowserPasswordAccessRoutes(app, access); app.use(express.json()); registerNativeDeploymentRoutes(app, { access, service, resolveOwner });
 const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
 const base = 'http://127.0.0.1:' + (server.address() as {port:number}).port;
 const post = (path: string, body: unknown, cookie = '', origin = base) => fetch(base + path, {method:'POST', headers:{'content-type':'application/json', cookie, origin}, body:JSON.stringify(body)});
 const root = '/api/foldy/native-deployments';
 try {
  expect((await post(root+'/prepare',s.request)).status).toBe(403); await expect(s.calls()).rejects.toThrow();
  const login = async () => (await post('/api/foldy-access/unlock',{password})).headers.get('set-cookie')!.split(';')[0]!;
  const viewerCookie = await login();
  // A shared browser password is viewer access, not deployment authority.
  expect((await post(root+'/prepare',s.request,viewerCookie)).status).toBe(403);
  await expect(s.calls()).rejects.toThrow();
  const cookie = ownerCookie, other = otherOwnerCookie;
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
test('no owner resolver fails closed even when a viewer session exists', async () => {
 const s = await serviceSetup(); const access = await createBrowserPasswordAccess({ dataRoot: s.dir });
 const password = randomBytes(24).toString('hex'); await access.configure(password);
 const app = express(); registerBrowserPasswordAccessRoutes(app, access); app.use(express.json());
 const service = new NativeDeploymentService<Request>({ consumer:new NativeCynderConsumer(s.config), dataRoot:s.dir, origin:s.config.origin, requireOwner:async()=>({principalId:'owner-1',sessionId:'session-1'}), resolveAdmission:async()=>s.admission });
 registerNativeDeploymentRoutes(app, { access, service });
 const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
 const base = 'http://127.0.0.1:' + (server.address() as {port:number}).port;
 try {
   const login = await fetch(base+'/api/foldy-access/unlock', {method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password})});
   const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
   const response = await fetch(base+'/api/foldy/native-deployments/prepare', {method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify(s.request)});
   expect(response.status).toBe(503);
   expect((await response.json() as { error: { code: string } }).error.code).toBe('FOLDY_OWNER_NOT_CONFIGURED');
   await expect(s.calls()).rejects.toThrow();
 } finally { await new Promise<void>((r,j)=>server.close(e=>e?j(e):r())); }
});
test('missing resolver fails before prepare consumer', async () => {
 const s = await serviceSetup(); const service = new NativeDeploymentService({consumer:new NativeCynderConsumer(s.config), dataRoot:s.dir, origin:s.config.origin, requireOwner:async()=>({principalId:'owner-1',sessionId:'session-1'})});
 await expect(service.prepare(null,s.request)).rejects.toThrow('FOLDY_HOSTING_NOT_CONFIGURED'); await expect(s.calls()).rejects.toThrow();
});
