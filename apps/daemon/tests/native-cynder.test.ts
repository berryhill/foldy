import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCynderConsumer, type NativeCynderConfig } from '../src/foldy-deployments/native-cynder.js';
const dirs: string[] = [];
async function deployed() {
  const s = await setup({ admittedActions: ['DEPLOY'] });
  const input = { ...s.input, request: { type: 'DEPLOY', image_digest: 'registry.example/app@sha256:' + 'a'.repeat(64), resource_class: 'mvi-small' } };
  const review = await s.bridge.prepare(input);
  return { ...s, input, review, deploymentId: 'dep_' + 'e'.repeat(32), versionId: 'ver_' + '1'.repeat(32) };
}
test('owner reads use exact installed CLI argv and durable original DEPLOY after restart', async () => {
  const s = await deployed();
  const dep = await s.bridge.getDeployment(s.input.operationId, s.deploymentId);
  const restarted = new NativeCynderConsumer(s.config);
  const list = await restarted.listVersions(s.input.operationId, s.deploymentId);
  const version = await restarted.getVersion(s.input.operationId, s.deploymentId, s.versionId);
  expect(JSON.stringify([dep, list, version])).not.toContain('canary');
  expect(version.version.actionId).not.toBe(s.review.actionId);
  const reads = (await s.calls()).filter(c => !c.command.startsWith('prepare-'));
  for (const call of reads) {
    const tail = [call.command, s.deploymentId, ...(call.command === 'version-get' ? [s.versionId] : []), '--deploy-action-id', s.review.actionId];
    expect(call.args).toEqual(['--origin', s.config.origin, '--state-dir', path.join(s.dir, 'foldy-native-cynder/consumer'), '--signer-helper', s.config.signerHelper, ...tail]);
  }
  expect(reads.map(c => c.command)).toContain('version-list');
  await expect(restarted.getDeployment(s.input.operationId, 'dep_' + 'f'.repeat(32))).rejects.toThrow('CYNDER_DEPLOYMENT_BINDING_MISMATCH');
});
test.each(['wrong-deployment', 'wrong-deploy-action', 'wrong-version', 'bad-version-action', 'malformed', 'error'])('owner reads reject %s without raw errors', async mode => {
  const s = await deployed(); await s.bridge.getDeployment(s.input.operationId, s.deploymentId); await s.mode(mode);
  await expect(s.bridge.getVersion(s.input.operationId, s.deploymentId, s.versionId)).rejects.toThrow(/^CYNDER_(INVALID_RESPONSE|CONSUMER_FAILED)$/);
});
test.each(['null-active-version', 'absent-active-version'])('owner reads allow %s without inventing an active pointer', async mode => {
  const s = await deployed(); await s.mode(mode);
  const dep = await s.bridge.getDeployment(s.input.operationId, s.deploymentId);
  expect(dep.activeVersionId).toBeUndefined();
  expect(dep.activeActivationId).toBe('act_' + '3'.repeat(32));
  const list = await s.bridge.listVersions(s.input.operationId, s.deploymentId);
  expect(list.activeVersionId).toBeUndefined();
  expect(list.versions).toHaveLength(1);
});
test('owner reads reject a non-action activation prefix', async () => {
  const s = await deployed(); await s.mode('bad-activation-prefix');
  await expect(s.bridge.getDeployment(s.input.operationId, s.deploymentId)).rejects.toThrow('CYNDER_INVALID_RESPONSE');
});
test('owner reads reject non-DEPLOY authorization, malformed IDs and custody changes', async () => {
  const s = await setup(); await s.bridge.prepare(s.input);
  await expect(s.bridge.getDeployment(s.input.operationId, s.input.request.deployment_id)).rejects.toThrow('CYNDER_ORIGINAL_DEPLOY_REQUIRED');
  const d = await deployed();
  await expect(d.bridge.getVersion(d.input.operationId, d.deploymentId, '../version')).rejects.toThrow('CYNDER_INVALID_INPUT');
  await chmod(d.config.signerHelper, 0o777);
  await expect(d.bridge.getDeployment(d.input.operationId, d.deploymentId)).rejects.toThrow('CYNDER_INVALID_CONFIG');
});

afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup(overrides: Partial<NativeCynderConfig> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-cynder-test-')); dirs.push(dir);
  const helper = path.join(dir, 'unused-helper'); await writeFile(helper, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const control = path.join(dir, 'control.json'); await writeFile(control, '{}');
  // Install fixture bytes under protected ancestry, independent of checkout/nvm modes.
  const consumer = path.join(dir, 'consumer.ts');
  await writeFile(consumer, await readFile(fileURLToPath(new URL('./fixtures/native-cynder-consumer.ts', import.meta.url))), { mode: 0o700 });
  const runtime = path.join(dir, 'node');
  await writeFile(runtime, await readFile(process.execPath), { mode: 0o700 });
  const config: NativeCynderConfig = { consumerPath: consumer, pythonPath: runtime, origin: 'https://cynder.example', dataRoot: dir,
    consumerSha256: createHash('sha256').update(await readFile(consumer)).digest('hex'), admittedActions: ['DELETE'],
    signerHelper: helper, paymentHelper: helper, expectedPayee: '0x' + 'c'.repeat(40), timeoutMs: 5000,
    helperEnvironment: { CYNDER_SIGNER_FIXTURE_FILE: control }, ...overrides };
  const bridge = new NativeCynderConsumer(config);
  const input = { operationId: '1'.repeat(64), request: { type: 'DELETE', deployment_id: 'dep_' + 'e'.repeat(32) },
    idempotencyKey: 'test-key', reviewedStateDigest: '2'.repeat(64) };
  const budget = { budgetId: 'budget-1', perActionCap: 10, totalCap: 20 };
  const calls = async () => (await readFile(path.join(dir, 'foldy-native-cynder', 'consumer', 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] });
  const mode = (value: string) => writeFile(control, JSON.stringify({ mode: value }));
  const quoted = async () => { await bridge.prepare(input); return bridge.challenge(input.operationId, budget); };
  return { bridge, config, input, budget, calls, mode, quoted, dir };
}
test('native prepare/challenge/exact execute persists identity and emits only safe fields', async () => {
  const s = await setup(); const q = await s.quoted();
  const result = await s.bridge.execute({ ...s.input, requestDigest: q.requestDigest, approvedQuote: q.quote!, allowSpend: true });
  expect(result.observation).toEqual({ actionId: q.actionId, status: 'SUCCEEDED', paymentStatus: 'SETTLED', settledEvidence: true });
  expect(JSON.stringify(result)).not.toContain('canary');
  const calls = await s.calls(); expect(calls.map(c => c.command)).toEqual(['prepare-delete', 'challenge', 'execute']);
  expect(calls[0]!.args).not.toContain('--payment-helper'); expect(calls[2]!.args).toContain('--payment-helper');
  expect(await new NativeCynderConsumer(s.config).inspect(s.input.operationId)).toEqual(result);
});
test('changed reviewed state and request rejected before invoking consumer', async () => {
  const s = await setup(); await s.quoted();
  await expect(s.bridge.prepare({ ...s.input, reviewedStateDigest: '3'.repeat(64) })).rejects.toThrow('CYNDER_REVIEW_CHANGED');
  await expect(s.bridge.prepare({ ...s.input, request: { ...s.input.request, deployment_id: 'dep_' + 'f'.repeat(32) } })).rejects.toThrow('CYNDER_REVIEW_CHANGED');
  expect((await s.calls()).length).toBe(2);
});
test.each(['quoteId', 'amountAtomic', 'network', 'asset', 'payee', 'actionId', 'budgetId', 'totalCapAtomic'] as const)('exact approval rejects substituted %s', async field => {
  const s = await setup(); const q = await s.quoted(); const modified = { ...q.quote!, [field]: typeof q.quote![field] === 'number' ? 9 : 'changed' };
  await expect(s.bridge.execute({ ...s.input, requestDigest: q.requestDigest, approvedQuote: modified, allowSpend: true })).rejects.toThrow('CYNDER_APPROVAL_MISMATCH');
  expect((await s.calls()).length).toBe(2);
});
test('uncertain execution after restart only reconciles same action, unpaid cannot authorize replay', async () => {
  const s = await setup(); const q = await s.quoted(); const approval = { ...s.input, requestDigest: q.requestDigest, approvedQuote: q.quote!, allowSpend: true as const };
  await s.mode('ambiguous'); await expect(s.bridge.execute(approval)).rejects.toThrow('CYNDER_CONSUMER_FAILED');
  const restarted = new NativeCynderConsumer(s.config); await s.mode('');
  expect((await restarted.reconcile(s.input.operationId)).phase).toBe('execution_unknown');
  await expect(restarted.execute(approval)).rejects.toThrow('CYNDER_RECONCILE_REQUIRED');
  await expect(restarted.challenge(s.input.operationId, s.budget)).rejects.toThrow('CYNDER_RECONCILE_REQUIRED');
  await expect(restarted.prepare({ ...s.input, operationId: '9'.repeat(64), idempotencyKey: 'replacement' })).rejects.toThrow('CYNDER_RECONCILE_REQUIRED');
  await s.mode('settled'); expect((await restarted.reconcile(s.input.operationId)).observation?.settledEvidence).toBe(true);
  expect((await s.calls()).filter(c => c.command === 'execute').length).toBe(1);
});
test('consumer stderr and raw response never escape errors', async () => {
  const s = await setup(); await s.mode('error');
  await expect(s.bridge.prepare(s.input)).rejects.toThrow(/^CYNDER_CONSUMER_FAILED$/);
});
test('bounded output terminates consumer', async () => {
  const s = await setup({ maxOutputBytes: 1024 }); await s.mode('overflow');
  await expect(s.bridge.prepare(s.input)).rejects.toThrow('CYNDER_CONSUMER_OUTPUT_LIMIT');
});
test('bounded deadline terminates consumer', async () => {
  const s = await setup({ timeoutMs: 150 }); await s.mode('timeout');
  await expect(s.bridge.prepare(s.input)).rejects.toThrow('CYNDER_CONSUMER_TIMEOUT');
});
test('rejects quote above cap and changed action readback', async () => {
  const s = await setup(); await s.bridge.prepare(s.input); await s.mode('overcap');
  await expect(s.bridge.challenge(s.input.operationId, s.budget)).rejects.toThrow('CYNDER_INVALID_RESPONSE');
  await s.mode('wrong-action'); await expect(s.bridge.reconcile(s.input.operationId)).rejects.toThrow('CYNDER_INVALID_RESPONSE');
});
test('concurrent writers fail closed', async () => {
  const s = await setup({ timeoutMs: 200 }); await s.mode('timeout');
  const first = s.bridge.prepare(s.input).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 40));
  await expect(new NativeCynderConsumer(s.config).prepare(s.input)).rejects.toThrow('CYNDER_BUSY_OR_RECOVERY_REQUIRED');
  await first;
});
test('unadmitted provider capability and changed installed consumer contract fail closed', async () => {
  const unsupported = await setup({ admittedActions: [] });
  await expect(unsupported.bridge.prepare(unsupported.input)).rejects.toThrow('CYNDER_CAPABILITY_NOT_ADMITTED');
  const changed = await setup({ consumerSha256: '0'.repeat(64) });
  await expect(changed.bridge.prepare(changed.input)).rejects.toThrow('CYNDER_CONSUMER_CONTRACT_CHANGED');
});

test.each(['PENDING', 'EXECUTING', 'WAITING_EFFECTIVE_TIME'])('paid %s never clears reconciliation', async status => {
  const s = await setup(); const q = await s.quoted(); await s.mode('paid-' + status);
  await expect(s.bridge.execute({ ...s.input, requestDigest: q.requestDigest, approvedQuote: q.quote!, allowSpend: true })).rejects.toThrow(/^CYNDER_INVALID_RESPONSE$/);
  await expect(s.bridge.reconcile(s.input.operationId)).rejects.toThrow(/^CYNDER_INVALID_RESPONSE$/);
  expect((await s.bridge.inspect(s.input.operationId)).phase).toBe('execution_unknown');
});
test('consumer contract accepts checksummed settled payment addresses', async () => {
  const s = await setup(); const q = await s.quoted(); await s.mode('checksummed');
  expect((await s.bridge.execute({ ...s.input, requestDigest: q.requestDigest, approvedQuote: q.quote!, allowSpend: true })).phase).toBe('observed');
});
test.each(['enroll-active', 'enroll-x402', 'enroll-profile', 'enroll-scopes'])('enrollment rejects %s', async mode => {
  const s = await setup({ admittedActions: ['ENROLL_WALLET'] });
  const input = { ...s.input, request: { type: 'ENROLL_WALLET', profile_name: 'fixture', requested_scopes: ['invoke'] } };
  await s.bridge.prepare(input); const q = await s.bridge.challenge(input.operationId, s.budget); await s.mode(mode);
  await expect(s.bridge.execute({ ...input, requestDigest: q.requestDigest, approvedQuote: q.quote!, allowSpend: true })).rejects.toThrow(/^CYNDER_INVALID_RESPONSE$/);
  await expect(s.bridge.reconcile(input.operationId)).rejects.toThrow(/^CYNDER_INVALID_RESPONSE$/);
});
test('valid enrollment stays pending review and UNKNOWN remains unresolved', async () => {
  const s = await setup({ admittedActions: ['ENROLL_WALLET'] });
  const input = { ...s.input, request: { type: 'ENROLL_WALLET', profile_name: 'fixture', requested_scopes: ['invoke'] } };
  await s.bridge.prepare(input); const q = await s.bridge.challenge(input.operationId, s.budget);
  await s.mode('paid-UNKNOWN');
  const uncertain = await s.bridge.execute({ ...input, requestDigest: q.requestDigest, approvedQuote: q.quote!, allowSpend: true });
  expect(uncertain.phase).toBe('execution_unknown');
  await s.mode('enroll-valid');
  expect((await s.bridge.reconcile(input.operationId)).phase).toBe('observed');
});
test.each(['preparing', 'execution_unknown'])('other %s operation blocks already prepared and quoted operations', async phase => {
  const s = await setup(); const q = await s.quoted();
  const other = { ...s.input, operationId: '9'.repeat(64), idempotencyKey: 'other' }; await s.bridge.prepare(other);
  const file = path.join(s.dir, 'foldy-native-cynder', other.operationId + '.json');
  const record = JSON.parse(await readFile(file, 'utf8')); record.phase = phase; await writeFile(file, JSON.stringify(record));
  const before = (await s.calls()).length;
  await expect(s.bridge.challenge(s.input.operationId, s.budget)).rejects.toThrow(/^CYNDER_RECONCILE_REQUIRED$/);
  await expect(s.bridge.execute({ ...s.input, requestDigest: q.requestDigest, approvedQuote: q.quote!, allowSpend: true })).rejects.toThrow(/^CYNDER_RECONCILE_REQUIRED$/);
  expect((await s.calls()).length).toBe(before);
});
test.each(['root-link', 'record-link', 'consumer-link', 'writable-parent', 'writable-consumer', 'helper-parent'])('protected paths reject %s before side effects', async scenario => {
  const s = await setup(); const root = path.join(s.dir, 'foldy-native-cynder');
  const outside = path.join(s.dir, 'outside'); await mkdir(outside, { mode: 0o755 });
  let bridge = s.bridge;
  if (scenario === 'root-link') await symlink(outside, root);
  if (scenario === 'record-link') { await s.quoted(); const file = path.join(root, s.input.operationId + '.json'); await writeFile(path.join(outside, 'record'), await readFile(file)); await rm(file); await symlink(path.join(outside, 'record'), file); }
  if (scenario === 'consumer-link') { await mkdir(root, { mode: 0o700 }); await symlink(outside, path.join(root, 'consumer')); }
  if (scenario === 'writable-parent') await chmod(s.dir, 0o777);
  if (scenario === 'writable-consumer') { await chmod(outside, 0o777); bridge = new NativeCynderConsumer({ ...s.config, consumerStateDir: outside }); }
  if (scenario === 'helper-parent') { await chmod(outside, 0o777); const helper = path.join(outside, 'helper'); await writeFile(helper, 'unused', { mode: 0o700 }); bridge = new NativeCynderConsumer({ ...s.config, signerHelper: helper }); }
  const before = (await stat(outside)).mode;
  await expect(bridge.prepare(s.input)).rejects.toThrow(/^CYNDER_INVALID_CONFIG$/);
  expect((await stat(outside)).mode).toBe(before);
});
