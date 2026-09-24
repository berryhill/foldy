import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../dist/domain.js';

const seed = { manifest: { instanceId: 'instance', projectId: 'project', workbookId: 'workbook', revisionId: 'base' }, files: new Map([['index.html', { bytes: Buffer.from('<h1>Original</h1>'), mediaType: 'text/html' }]]) };
const owner: { id: string; owner: boolean; scopes: string[] } = { id: 'owner', owner: true, scopes: [] };
const reader = { id: 'reader', owner: false, scopes: ['foldy:read'] };
const writer = { id: 'writer', owner: false, scopes: ['foldy:read', 'foldy:draft:write'] };

test('per-update receipt pages expose all operations and check/actor/revision evidence without authored content or custody', () => {
 const root = mkdtempSync(join(tmpdir(), 'foldy-receipt-history-'));
 const d = new Domain(join(root, 'source'), seed);
 try {
  let n = 0;
  const run = (name: string, extra: Record<string, unknown>, actor = owner) => d.dispatch(name, { projectId: 'project', expectedBaseRevisionId: 'base', idempotencyKey: `key-${++n}`, ...extra }, actor);
  const created = run('create_update', { title: 'PRIVATE_TITLE_CANARY' }, writer);
  const ref = { updateId: created.updateId, expectedUpdateRevisionId: created.updateRevisionId };
  const edited = run('update_page', { ...ref, path: 'index.html', content: 'PRIVATE_CONTENT_CANARY' }, writer);
  ref.expectedUpdateRevisionId = edited.updateRevisionId;
  const submitted = run('submit_update_for_review', ref, writer);
  assert.deepEqual(d.dispatch('submit_update_for_review', { projectId: 'project', expectedBaseRevisionId: 'base', idempotencyKey: 'key-3', ...ref }, writer), submitted);
  const commented = run('add_review_comment', { ...ref, text: 'PRIVATE_COMMENT_CANARY', blocking: false, target: { path: 'index.html' } });
  const approved = run('approve_update_revision', { ...ref, reason: 'PRIVATE_REASON_CANARY' });
  const published = run('publish_update', { ...ref, reason: 'PRIVATE_PUBLISH_CANARY' });
  const other = run('create_update', { title: 'OTHER_TITLE_CANARY', expectedBaseRevisionId: d.current() }, writer);
  const expected = [created, edited, submitted, commented, approved, published];
  const args = { projectId: 'project', updateId: created.updateId };
  assert.ok(d.tools(reader).some(t => t.name === 'list_update_receipts'));
  const first = d.dispatch('list_update_receipts', { ...args, limit: '2' }, reader);
  assert.equal(first.observedRevisionId, edited.updateRevisionId);
  assert.deepEqual(first.value.receipts.map((r: any) => r.receiptId), expected.slice(0, 2).map(r => r.receiptId));
  assert.equal(first.value.nextCursor, edited.receiptId);
  const second = d.dispatch('list_update_receipts', { ...args, limit: '2', afterReceiptId: first.value.nextCursor }, reader);
  const third = d.dispatch('list_update_receipts', { ...args, limit: '2', afterReceiptId: second.value.nextCursor }, reader);
  assert.deepEqual([...first.value.receipts, ...second.value.receipts, ...third.value.receipts].map((r: any) => r.operation), expected.map(r => r.operation));
  assert.equal(third.value.nextCursor, null);
  const all = d.dispatch('list_update_receipts', args, reader);
  assert.deepEqual(all.value.receipts.map((r: any) => r.receiptId), expected.map(r => r.receiptId));
  assert.equal(all.value.receipts[0].actorRef, writer.id);
  assert.equal(all.value.receipts[2].checksEvidence.revisionId, edited.updateRevisionId);
  assert.deepEqual(Object.keys(all.value.receipts[2].checksEvidence).sort(), ['failureCount', 'filesDigest', 'pass', 'revisionId']);
  assert.equal(all.value.receipts[4].checksEvidence.pass, true);
  assert.equal(all.value.receipts[5].currentPublishedRevisionId, edited.updateRevisionId);
  assert.equal(all.value.receipts[3].commentId, commented.commentId);
  assert.deepEqual(d.dispatch('get_update', args, reader).value.decisions.map((r: any) => r.receiptId), [approved, published].map(r => r.receiptId));
  for (const canary of ['PRIVATE_TITLE_CANARY', 'PRIVATE_CONTENT_CANARY', 'PRIVATE_COMMENT_CANARY', 'PRIVATE_REASON_CANARY', 'PRIVATE_PUBLISH_CANARY', 'key-', other.updateId]) assert.ok(!JSON.stringify(all).includes(canary), canary);
  assert.throws(() => d.dispatch('list_update_receipts', { ...args, afterReceiptId: other.receiptId }, reader), /REQUEST_INVALID/);
  assert.throws(() => d.dispatch('list_update_receipts', { ...args, limit: '0' }, reader), /REQUEST_INVALID/);
  assert.throws(() => d.dispatch('list_update_receipts', { ...args, limit: '101' }, reader), /REQUEST_INVALID/);
  assert.throws(() => d.dispatch('list_update_receipts', { ...args, limit: '1.5' }, reader), /REQUEST_INVALID/);
  assert.throws(() => d.dispatch('list_update_receipts', { ...args, atRevisionId: created.updateRevisionId }, reader), /REVISION_CONFLICT/);
  assert.throws(() => d.dispatch('list_update_receipts', { ...args, projectId: 'other' }, reader), /PROJECT_MISMATCH/);
  assert.throws(() => d.dispatch('list_update_receipts', args, { id: 'none', owner: false, scopes: [] }), /SCOPE_REQUIRED/);
  assert.throws(() => d.dispatch('list_update_receipts', { ...args, unknown: 'x' }, reader), /REQUEST_INVALID/);
  const backup = d.backup(owner);
  const restoredPath = join(root, 'restored');
  Domain.restore(restoredPath, backup, owner, seed.manifest);
  const restored = new Domain(restoredPath, seed);
  try {
   assert.deepEqual(restored.dispatch('list_update_receipts', args, reader), all);
   assert.deepEqual(restored.dispatch('get_revision_history', {}, reader), d.dispatch('get_revision_history', {}, reader));
   assert.deepEqual(restored.dispatch('get_readiness_checks', args, reader), d.dispatch('get_readiness_checks', args, reader));
   assert.deepEqual(restored.dispatch('list_update_receipts', { ...args, limit: '2', afterReceiptId: first.value.nextCursor }, reader), second);
  } finally { restored.close(); }
 } finally { d.close(); rmSync(root, { recursive: true, force: true }); }
});

test('receipt cursor traverses more than the maximum page size even with identical timestamps', t => {
 t.mock.timers.enable({ apis: ['Date'], now: 1789800000000 });
 const root = mkdtempSync(join(tmpdir(), 'foldy-receipt-pages-'));
 const d = new Domain(join(root, 'source'), seed);
 try {
  const created = d.dispatch('create_update', { projectId: 'project', expectedBaseRevisionId: 'base', idempotencyKey: 'create', title: 'many' }, owner);
  const args = { projectId: 'project', expectedBaseRevisionId: 'base', updateId: created.updateId, expectedUpdateRevisionId: created.updateRevisionId };
  const ids = [created.receiptId];
  for (let n = 0; n < 102; n++) ids.push(d.dispatch('request_update_changes', { ...args, idempotencyKey: `request-${n}`, reason: 'PRIVATE_REASON_CANARY' }, owner).receiptId);
  const first = d.dispatch('list_update_receipts', { updateId: created.updateId, limit: '100' }, reader);
  assert.equal(first.value.receipts.length, 100);
  assert.equal(first.value.nextCursor, ids[99]);
  const last = d.dispatch('list_update_receipts', { updateId: created.updateId, afterReceiptId: first.value.nextCursor }, reader);
  assert.deepEqual([...first.value.receipts, ...last.value.receipts].map((r: any) => r.receiptId), ids);
  assert.equal(last.value.nextCursor, null);
  assert.equal(new Set(last.value.receipts.map((r: any) => r.occurredAt)).size, 1);
  assert.ok(!JSON.stringify(last).includes('PRIVATE_REASON_CANARY'));
  const raw = d.backup(owner);
  Domain.restore(join(root, 'restored'), raw, owner, seed.manifest);
  const restored = new Domain(join(root, 'restored'), seed);
  try { assert.deepEqual(restored.dispatch('list_update_receipts', { updateId: created.updateId, afterReceiptId: first.value.nextCursor }, reader), last); }
  finally { restored.close(); }
 } finally { d.close(); rmSync(root, { recursive: true, force: true }); }
});
