#!/usr/bin/env node
// Synthetic packaged CLI protocol; no networking, signing, or helper execution.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const get = (flag: string): string => args[args.indexOf(flag) + 1]!;
const dir = get('--state-dir'); mkdirSync(dir, { recursive: true });
const command = args.find(a => /^(prepare-|challenge$|execute$|action-get$|deployment-get$|version-list$|version-get$)/.test(a))!;
appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ command, args }) + '\n');
const control = JSON.parse(readFileSync(process.env.CYNDER_SIGNER_FIXTURE_FILE!, 'utf8')) as { mode?: string };
const id = 'act_' + 'a'.repeat(32); const digest = 'b'.repeat(64);
const asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; const payee = '0x' + 'c'.repeat(40);
if (control.mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 60_000));
if (control.mode === 'overflow') { process.stdout.write('X'.repeat(300_000)); process.exit(0); }
if (control.mode === 'error' || (control.mode === 'ambiguous' && command === 'execute')) {
  process.stderr.write('synthetic-private-canary'); process.exit(2);
}
if (command.startsWith('prepare-')) {
  const request = JSON.parse(get('--request'));
  if ('type' in request) process.exit(2);
  const type = command.slice(8).replaceAll('-', '_').toUpperCase();
  writeFileSync(path.join(dir, 'type'), type);
  process.stdout.write(JSON.stringify({ origin: get('--origin'), action_id: id, digest, type,
    idempotency_key: get('--idempotency-key'), signature: 'synthetic-private-canary' }));
} else if (command === 'challenge') {
  process.stdout.write(JSON.stringify({ origin: get('--origin'), action_id: id, quote_id: 'd'.repeat(64), amount_atomic: control.mode === 'overcap' ? 999 : 5,
    network: 'eip155:8453', asset, payee, budget_id: get('--budget-id'), total_cap_atomic: Number(get('--total-cap')),
    payment_required: 'synthetic-private-canary' }));
} else if (['deployment-get', 'version-list', 'version-get'].includes(command)) {
  const dep = 'dep_' + 'e'.repeat(32); const ver = 'ver_' + '1'.repeat(32);
  const version = { deployment_id: control.mode === 'wrong-deployment' ? 'dep_' + 'f'.repeat(32) : dep,
    version_id: control.mode === 'wrong-version' ? 'ver_' + '2'.repeat(32) : ver,
    action_id: control.mode === 'bad-version-action' ? 'invalid' : 'act_' + '9'.repeat(32),
    image_digest: 'registry.example/app@sha256:' + 'a'.repeat(64), created_at: '2026-01-01T00:00:00Z',
    credentials: 'synthetic-private-canary' };
  const deployment = { deployment_id: version.deployment_id, deploy_action_id: control.mode === 'wrong-deploy-action' ? 'act_' + 'f'.repeat(32) : id,
    status: 'READY', deleted: false, delete_pending: false,
    active_version_id: control.mode === 'null-active-version' ? null : control.mode === 'absent-active-version' ? undefined : ver,
    active_activation_id: (control.mode === 'bad-activation-prefix' ? 'acv_' : 'act_') + '3'.repeat(32),
    image_digest: version.image_digest, resource_class: 'mvi-small', created_at: version.created_at, updated_at: version.created_at,
    credentials: 'synthetic-private-canary' };
  if (control.mode === 'malformed') process.stdout.write('{');
  else process.stdout.write(JSON.stringify(command === 'deployment-get' ? deployment : command === 'version-list'
    ? { deployment_id: dep, active_version_id: deployment.active_version_id, versions: [version], credentials: 'synthetic-private-canary' }
    : { active: true, version, credentials: 'synthetic-private-canary' }));
} else {
  // Mirrors validate_execution_view in packaged cynder_agent.py: terminal paid
  // states, case-insensitive payment addresses, and pending-review enrollment.
  const settled = command === 'execute' || control.mode === 'settled' || control.mode?.startsWith('paid-') || control.mode?.startsWith('enroll-');
  const status = control.mode?.startsWith('paid-') ? control.mode.slice(5) : settled ? 'SUCCEEDED' : 'PENDING';
  const enrollment = { status: control.mode === 'enroll-active' ? 'ACTIVE' : 'PENDING_REVIEW',
    x402_active: control.mode === 'enroll-x402', profile_name: control.mode === 'enroll-profile' ? 'other' : 'fixture',
    requested_scopes: control.mode === 'enroll-scopes' ? ['other'] : ['invoke'] };
  process.stdout.write(JSON.stringify({ action: { action_id: control.mode === 'wrong-action' ? 'act_' + 'f'.repeat(32) : id,
    digest, type: readFileSync(path.join(dir, 'type'), 'utf8') },
    state: { action_id: id, status, payment_status: settled ? 'SETTLED' : 'UNPAID',
      payment_amount: '5', payment_asset: control.mode === 'checksummed' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : asset,
      payment_pay_to: control.mode === 'checksummed' ? '0x' + 'Cc'.repeat(20) : payee }, receipts: [{ action_id: id }],
    output: { ...enrollment, private_key: 'synthetic-private-canary' } }));
}
