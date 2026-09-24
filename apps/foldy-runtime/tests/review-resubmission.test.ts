import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Domain, type Actor } from '../dist/domain.js';

const owner: Actor = { id: 'owner', owner: true, scopes: [] };
const writer: Actor = { id: 'writer', owner: false, scopes: ['foldy:read', 'foldy:draft:write'] };

for (const rejection of ['request_update_changes', 'blocking review comment'] as const) {
 test(`${rejection} requires renewed submission of the exact revision before approval`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'foldy-resubmission-'));
  const domain = new Domain(join(dir, 'content.sqlite'), {
   manifest: { instanceId: 'i', projectId: 'p', workbookId: 'w', revisionId: 'base' },
   files: new Map([['index.html', { bytes: Buffer.from('<h1>Original</h1>'), mediaType: 'text/html' }]]),
  });
  let sequence = 0;
  const run = (name: string, ref: Record<string, unknown> = {}, actor = owner) => domain.dispatch(name, {
   projectId: 'p', expectedBaseRevisionId: 'base', idempotencyKey: String(++sequence), ...ref,
  }, actor);
  try {
   const created = run('create_update', { title: 'Proposal' }, writer);
   const ref = { updateId: created.updateId, expectedUpdateRevisionId: created.updateRevisionId };
   run('submit_update_for_review', ref, writer);
   if (rejection === 'request_update_changes') run('request_update_changes', { ...ref, reason: 'Revise the proposal' });
   else {
    const comment = run('add_review_comment', { ...ref, text: 'Revise this section', blocking: true, target: { path: 'index.html' } });
    assert.throws(() => run('approve_update_revision', { ...ref, reason: 'too early' }), /BLOCKING_COMMENTS/);
    run('resolve_review_comment', { ...ref, commentId: comment.commentId, reason: 'addressed' });
   }
   const before = domain.dispatch('get_update', { updateId: ref.updateId }, owner).value;
   assert.equal(before.state, 'Changes requested');
   assert.throws(() => run('approve_update_revision', { ...ref, reason: 'without renewed review' }), /REVIEW_REQUIRED/);
   assert.equal(domain.dispatch('get_update', { updateId: ref.updateId }, owner).value.state, 'Changes requested');
   const saved = run('save_update_revision', ref, writer);
   const newRef = { ...ref, expectedUpdateRevisionId: saved.updateRevisionId };
   assert.throws(() => run('approve_update_revision', { ...newRef, reason: 'draft not submitted' }), /REVIEW_REQUIRED/);
   assert.throws(() => run('submit_update_for_review', ref, writer), /REVISION_CONFLICT/);
   const submitted = run('submit_update_for_review', newRef, writer);
   assert.equal(submitted.checksEvidence.pass, true);
   assert.equal(submitted.checksEvidence.revisionId, newRef.expectedUpdateRevisionId);
   assert.equal(run('approve_update_revision', { ...newRef, reason: 'reviewed resubmission' }).currentState, 'Approved');
   assert.equal(domain.dispatch('get_update', { updateId: ref.updateId }, owner).value.approval, newRef.expectedUpdateRevisionId);
  } finally { domain.close(); rmSync(dir, { recursive: true, force: true }); }
 });
}
