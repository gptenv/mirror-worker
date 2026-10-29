import assert from 'node:assert/strict';
import test from 'node:test';
import { getEgressStatus } from '../dist/egress.js';

test.describe('server / egress', () => {
  test('reports direct Node egress without claiming a WARP verification', () => {
    const status = getEgressStatus();
    assert.equal(status.mode, 'direct');
    assert.equal(status.required, false);
    assert.equal(status.verified, true);
    assert.equal(status.error, null);
    assert.ok(Number.isFinite(Date.parse(status.checkedAt)));
    status.mode = 'modified';
    assert.equal(getEgressStatus().mode, 'direct');
  });
});
