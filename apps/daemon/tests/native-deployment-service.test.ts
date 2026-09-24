import { afterEach, expect, test } from 'vitest';
import { setup, cleanup } from './helpers/native-cynder.js';
afterEach(cleanup);
import { NativeCynderConsumer } from '../src/foldy-deployments/native-cynder.js';
import { NativeDeploymentService, type HostingAdmission, type NativeDeploymentRequest } from '../src/foldy-deployments/native-deployment-service.js';
import { serviceSetup } from './helpers/native-deployment.js';
const owner = 'authenticated-owner';
test('reconciliation drops deployment evidence unless refreshed in this observation', async () => {
  const s = await serviceSetup(); const q = await s.service.prepare(owner, s.request); await s.mode('settled');
  await s.service.execute(owner, { operationId: q.operationId, requestDigest: q.review!.requestDigest,
    reviewedStateDigest: q.review!.reviewedStateDigest, approvedQuote: q.review!.quote! });
  expect((await s.service.reconcile(owner, q.operationId, 'dep_' + 'e'.repeat(32))).deployment).toBeDefined();
  const current = await s.make().reconcile(owner, q.operationId);
  expect(current.deployment).toBeUndefined();
  expect((await s.make().inspect(owner, q.operationId)).deployment).toBeUndefined();
});
test.each(['owner', 'project'])('same client key is isolated across %s scope', async scope => {
  const s = await serviceSetup();
  const service = new NativeDeploymentService({ consumer: s.bridge, dataRoot: s.dir, origin: s.config.origin,
    requireOwner: async (principalId: string) => ({ principalId, sessionId: 'session-1' }),
    resolveAdmission: async (_ref, o, release) => ({ ...s.admission, release, ownerPrincipalId: o.principalId,
      bootstrap: { ...s.admission.bootstrap, ownerPrincipalId: o.principalId } }) });
  const q1 = await service.prepare('owner-1', s.request);
  const other = scope === 'owner' ? 'owner-2' : 'owner-1';
  const request = structuredClone(s.request);
  if (scope === 'project') request.release.projectId = 'project-2';
  const q2 = await service.prepare(other, request);
  expect(q2.operationId).not.toBe(q1.operationId);
  await s.mode('settled');
  for (const [principal, q] of [['owner-1', q1], [other, q2]] as const) {
    expect((await service.execute(principal, { operationId: q.operationId, requestDigest: q.review!.requestDigest,
      reviewedStateDigest: q.review!.reviewedStateDigest, approvedQuote: q.review!.quote! })).state).toBe('observed');
  }
});
test.each(['execute', 'execute-reconcile', 'reconcile'].flatMap(stage =>
  ['operationId', 'requestDigest', 'reviewedStateDigest', 'actionId', 'observation'].map(field => [stage, field])))('rejects %s review with substituted %s', async (stage, field) => {
  const s = await serviceSetup(); const consumer = new NativeCynderConsumer(s.config);
  const service = new NativeDeploymentService({ consumer, dataRoot: s.dir, origin: s.config.origin,
    requireOwner: async () => ({ principalId: 'owner-1', sessionId: 'session-1' }), resolveAdmission: async () => s.admission });
  const q = await service.prepare(owner, s.request); await s.mode('settled');
  const approval = { operationId: q.operationId, requestDigest: q.review!.requestDigest,
    reviewedStateDigest: q.review!.reviewedStateDigest, approvedQuote: q.review!.quote! };
  if (stage === 'reconcile') await service.execute(owner, approval);
  const method = stage === 'execute' ? 'execute' : 'reconcile';
  const original = consumer[method].bind(consumer);
  Object.assign(consumer, { [method]: async (...args: unknown[]) => {
    const review = await (original as (...args: unknown[]) => Promise<import('../src/foldy-deployments/native-cynder.js').NativeCynderReview>)(...args);
    if (field === 'observation') review.observation = { actionId: 'wrong-action', status: 'SUCCEEDED', paymentStatus: 'SETTLED', settledEvidence: true };
    else Object.assign(review, { [field!]: 'wrong-value' });
    return review;
  } });
  await expect(stage === 'reconcile' ? service.reconcile(owner, q.operationId) : service.execute(owner, approval)).rejects.toThrow('FOLDY_DEPLOY_CUSTODY_MISMATCH');
  const persisted = await s.make().inspect(owner, q.operationId);
  expect(persisted.state).toBe('execution_unknown');
  expect(persisted.originalDeployActionId).toBe(q.originalDeployActionId);
  expect(persisted.review!.operationId).toBe(q.operationId);
});
test('service durable quote, exact approval, execute, reconcile and original DEPLOY owner readback', async () => {
  const s = await serviceSetup(); const q = await s.service.prepare(owner, s.request);
  expect(q.state).toBe('quoted');
  expect(await s.make().prepare(owner, s.request)).toEqual(q);
  const approval = { operationId: q.operationId, requestDigest: q.review!.requestDigest,
    reviewedStateDigest: q.review!.reviewedStateDigest, approvedQuote: q.review!.quote! };
  await s.mode('settled');
  expect((await s.make().execute(owner, approval)).state).toBe('observed');
  const result = await s.make().reconcile(owner, q.operationId, 'dep_' + 'e'.repeat(32));
  expect(result.state).toBe('deployment_observed'); expect(result.foldyActivation).toBe('not_verified');
  expect(result.originalDeployActionId).toBe(q.review!.actionId);
  expect((await s.calls()).map(c => c.command)).toEqual(['prepare-deploy', 'challenge', 'execute', 'action-get', 'action-get', 'deployment-get', 'deployment-get', 'version-get']);
  await expect(s.make().execute(owner, approval)).rejects.toThrow('FOLDY_APPROVAL_MISMATCH');
});
test.each(['durableStorage', 'bootstrap', 'singleWriter', 'transport'] as const)('missing %s fails before consumer process', async key => {
  const s = await serviceSetup(); delete (s.admission as unknown as Record<string, unknown>)[key];
  await expect(s.service.prepare(owner, s.request)).rejects.toThrow('FOLDY_HOSTING_NOT_ADMITTED');
  await expect(s.calls()).rejects.toThrow();
});
test('request owner booleans and anonymous contexts cannot authorize', async () => {
  const s = await serviceSetup();
  await expect(s.service.prepare(owner, { ...s.request, owner: true })).rejects.toThrow('FOLDY_INVALID_REQUEST');
  await expect(s.service.prepare('anonymous', s.request)).rejects.toThrow('AUTH_REQUIRED');
  await expect(s.calls()).rejects.toThrow();
});
test('approval substitution and revoked capability fail before execute', async () => {
  const s = await serviceSetup(); const q = await s.service.prepare(owner, s.request);
  const a = { operationId: q.operationId, requestDigest: q.review!.requestDigest, reviewedStateDigest: q.review!.reviewedStateDigest, approvedQuote: q.review!.quote! };
  await expect(s.service.execute(owner, { ...a, approvedQuote: { ...a.approvedQuote, amountAtomic: 1 } })).rejects.toThrow('FOLDY_APPROVAL_MISMATCH');
  s.admission.validUntil = '2000-01-01T00:00:00Z';
  await expect(s.service.execute(owner, a)).rejects.toThrow('FOLDY_HOSTING_NOT_ADMITTED');
  expect((await s.calls()).map(c => c.command)).toEqual(['prepare-deploy', 'challenge']);
});
test('unknown process outcome remains blocked across service restart', async () => {
  const s = await serviceSetup(); const q = await s.service.prepare(owner, s.request); await s.mode('error');
  const a = { operationId: q.operationId, requestDigest: q.review!.requestDigest, reviewedStateDigest: q.review!.reviewedStateDigest, approvedQuote: q.review!.quote! };
  await expect(s.service.execute(owner, a)).rejects.toThrow();
  expect((await s.make().inspect(owner, q.operationId)).state).toBe('execution_unknown');
  await expect(s.make().execute(owner, a)).rejects.toThrow('FOLDY_APPROVAL_MISMATCH');
  await s.mode('unpaid');
  const r = await s.make().reconcile(owner, q.operationId); expect(r.state).toBe('execution_unknown');
  await expect(s.make().prepare(owner, { ...s.request, idempotencyKey: 'replacement' })).rejects.toThrow('CYNDER_RECONCILE_REQUIRED');
});
