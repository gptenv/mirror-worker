import assert from 'node:assert/strict';
import test from 'node:test';
import { invariantSettings } from '../../../scripts/worker-deployment-settings.mjs';

test.describe('worker / deployment settings preservation', () => {
  const owner = { name: 'MIRROR_OWNER_ACCOUNT_ID', type: 'secret_text' };
  const storage = { name: 'MIRROR', type: 'durable_object_namespace', namespace_id: 'fixture-namespace' };
  const warp = { name: 'WARP', type: 'vpc_network', network_id: 'cf1:network' };
  const settings = { bindings: [owner, storage], compatibility_date: '2026-09-30', annotations: { 'workers/tag': 'previous' } };

  test('allows only restoration of the missing original WARP and annotation updates', () => {
    const restored = { ...settings, bindings: [warp, storage, owner], annotations: { 'workers/tag': 'current' } };
    assert.deepEqual(invariantSettings(settings, true), invariantSettings(restored));
    assert.deepEqual(invariantSettings(restored, true), invariantSettings(restored));
    assert.notDeepEqual(invariantSettings(restored), invariantSettings({ ...restored, compatibility_date: '2026-10-01' }));
    assert.notDeepEqual(invariantSettings(restored), invariantSettings({ ...restored, bindings: [warp, owner, { ...storage, namespace_id: 'changed' }] }));
    assert.notDeepEqual(invariantSettings(restored), invariantSettings({ ...restored, bindings: [warp, storage] }));
  });

  test('rejects missing, replaced, duplicated or differently scoped WARP bindings', () => {
    assert.throws(() => invariantSettings(settings), /exact required WARP/);
    for (const bindings of [[{ ...warp, network_id: 'other-network' }], [{ ...warp, tunnel_id: 'other-tunnel' }], [{ ...warp, type: 'service' }], [warp, warp]]) {
      for (const restoring of [true, false]) assert.throws(() => invariantSettings({ ...settings, bindings: [...settings.bindings, ...bindings] }, restoring), /exact required WARP/);
    }
  });
});
