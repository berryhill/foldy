import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationalStatus } from '../dist/operational-status.js';
test('bounded operational evidence persists without content or error strings', () => {
 const root=mkdtempSync(join(tmpdir(),'foldy-status-'));
 try {
  const status=new OperationalStatus(root);assert.equal(status.snapshot().lastBackup,null);
  const backup=status.backupPrepared('revision-1',1234);status.failure('request-1','backup');
  const restored=new OperationalStatus(root).snapshot();assert.deepEqual(restored.lastBackup,backup);assert.equal(restored.latestFailure?.requestId,'request-1');
  const detached=status.snapshot();detached.lastBackup!.revisionId='changed';assert.equal(status.snapshot().lastBackup!.revisionId,'revision-1');
  assert.throws(()=>status.failure('request-2','arbitrary secret' as 'backup'),/OPERATIONS_INPUT_INVALID/);
  assert.doesNotMatch(readFileSync(join(root,'operational-status.json'),'utf8'),/arbitrary secret/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('corrupt or publicly readable operation evidence fails closed', () => {
 const root=mkdtempSync(join(tmpdir(),'foldy-status-'));
 try {
  const status=new OperationalStatus(root);status.backupPrepared('r1',10);
  const path=join(root,'operational-status.json');chmodSync(path,0o644);assert.throws(()=>new OperationalStatus(root),/OPERATIONS_STATE_INVALID/);
  chmodSync(path,0o600);writeFileSync(path,JSON.stringify({...status.snapshot(),unexpected:'private payload'}));assert.throws(()=>new OperationalStatus(root),/OPERATIONS_STATE_INVALID/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
