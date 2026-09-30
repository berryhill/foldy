import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveArgon2, argon2Available } from '../dist/argon2-budget.js';

test('shared process budget reserves one lane for owner changes across viewer and owner login traffic', () => {
  const releaseViewerA = reserveArgon2('viewer');
  const releaseViewerB = reserveArgon2('viewer');
  const releaseLogin = reserveArgon2('owner-login');
  try {
    assert.equal(argon2Available('viewer'), false);
    assert.equal(argon2Available('owner-login'), false);
    assert.equal(argon2Available('owner-change'), true);
    const releaseOwner = reserveArgon2('owner-change');
    try {
      assert.equal(argon2Available('owner-change'), false);
      assert.throws(() => reserveArgon2('viewer'), /VERIFIER_UNAVAILABLE/);
    } finally { releaseOwner(); }
  } finally { releaseLogin(); releaseViewerB(); releaseViewerA(); }
  assert.equal(argon2Available('owner-change'), true);
  assert.equal(argon2Available('viewer'), true);
});
