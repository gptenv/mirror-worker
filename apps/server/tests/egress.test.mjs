import assert from 'node:assert/strict';
import test from 'node:test';
import { getEgressStatus } from '../dist/egress.js';

test.describe('server / egress', () => {
  test('reports Node configuration without inventing a successful connectivity check', () => {
    assert.deepEqual(getEgressStatus(), { mode: 'direct', required: false, verified: false, checkedAt: null, error: null });
    const status = getEgressStatus();
    status.mode = 'modified';
    assert.equal(getEgressStatus().mode, 'direct');
  });
  test('reports required Worker VPC transport as unverified, not direct or healthy', () => {
    globalThis.WebSocketPair = class {};
    try {
      assert.deepEqual(getEgressStatus(), { mode: 'warp-vpc', required: true, verified: false, checkedAt: null, error: null });
    } finally { delete globalThis.WebSocketPair; }
  });
});
