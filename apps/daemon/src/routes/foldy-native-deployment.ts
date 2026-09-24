import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { BrowserPasswordAccess } from '../foldy-access/browser-password.js';
import type { NativeDeploymentService, DeploymentOwner, NativeDeploymentApproval } from '../foldy-deployments/native-deployment-service.js';
import type { NativeDeploymentPrepareResponse } from '@open-design/contracts';
export function nativeDeploymentOwner(access: BrowserPasswordAccess, req: Request): DeploymentOwner {
  if (!access.isAdministrativeRequest(req)) throw new Error('FOLDY_ORIGIN_DENIED');
  if (!access.status(req).enabled || !access.isAuthorized(req)) throw new Error('FOLDY_SESSION_REQUIRED');
  const cookie = /(?:^|;\s*)foldy_browser_session=([^;]+)/.exec(req.get('cookie') ?? '')?.[1];
  if (!cookie) throw new Error('FOLDY_SESSION_REQUIRED');
  return { principalId: 'local-admin', sessionId: createHash('sha256').update(cookie).digest('hex') };
}
export function registerNativeDeploymentRoutes(app: Express, deps: {
  access: BrowserPasswordAccess; service?: NativeDeploymentService<Request>; now?: () => number;
}): void {
  const receipts = new Map<string, { session: string; csrf: string; expires: number; approval: NativeDeploymentApproval }>();
  const now = deps.now ?? Date.now;
  const wrap = (fn: (req: Request, owner: DeploymentOwner) => Promise<unknown>) => async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const owner = nativeDeploymentOwner(deps.access, req);
      if (!deps.service) { res.status(503).json({ error: { code: 'FOLDY_HOSTING_NOT_CONFIGURED' } }); return; }
      res.json(await fn(req, owner));
    } catch (e) {
      const code = e instanceof Error && /^(FOLDY|CYNDER)_[A-Z_]+$/.test(e.message) ? e.message : 'FOLDY_OPERATION_FAILED';
      res.status(code.endsWith('NOT_CONFIGURED') ? 503 : code.includes('SESSION') ? 401 : code.includes('DENIED') ? 403 : 400).json({ error: { code } });
    }
  };
  const root = '/api/foldy/native-deployments';
  app.post(root + '/prepare', wrap(async (req, owner) => {
    if (!req.is('application/json')) throw new Error('FOLDY_INVALID_REQUEST');
    for (const [key, r] of receipts) if (r.expires <= now()) receipts.delete(key);
    if (receipts.size >= 1000) throw new Error('FOLDY_RECEIPT_CAPACITY');
    const result = await deps.service!.prepare(req, req.body);
    const output: NativeDeploymentPrepareResponse = { result };
    if (result.state === 'quoted' && result.review?.quote) {
      const approvalReceipt = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), expiresAt = now() + 300000;
      receipts.set(approvalReceipt, { session: owner.sessionId, csrf, expires: expiresAt, approval: structuredClone({ operationId: result.operationId, requestDigest: result.review.requestDigest, reviewedStateDigest: result.review.reviewedStateDigest, approvedQuote: result.review.quote }) });
      Object.assign(output, { approvalReceipt, csrf, expiresAt });
    }
    return output;
  }));
  app.post(root + '/execute', wrap(async (req, owner) => {
    const body = req.body;
    if (!req.is('application/json') || !body || Object.keys(body).sort().join() !== 'approvalReceipt,csrf' || typeof body.approvalReceipt !== 'string' || typeof body.csrf !== 'string') throw new Error('FOLDY_INVALID_REQUEST');
    const r = receipts.get(body.approvalReceipt);
    if (!r || r.session !== owner.sessionId || r.csrf !== body.csrf || r.expires <= now()) throw new Error('FOLDY_APPROVAL_DENIED');
    receipts.delete(body.approvalReceipt); // consume synchronously before first await
    return deps.service!.execute(req, r.approval);
  }));
  app.get(root + '/:operationId', wrap(req => deps.service!.inspect(req, String(req.params.operationId))));
  app.post(root + '/:operationId/reconcile', wrap(req => {
    if (!req.is('application/json') || !req.body || Object.keys(req.body).some(k => k !== 'deploymentId') || (req.body.deploymentId !== undefined && typeof req.body.deploymentId !== 'string')) throw new Error('FOLDY_INVALID_REQUEST');
    return deps.service!.reconcile(req, String(req.params.operationId), req.body.deploymentId);
  }));
}
