import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const requiredWarp = { name: 'WARP', type: 'vpc_network', network_id: 'cf1:network' };

// The only authorized binding change is restoring the missing original WARP.
// Existing WARP configuration and every unrelated setting remain invariant.
export function invariantSettings(settings, restoreMissingWarp = false) {
  const { annotations, bindings, ...rest } = settings;
  const warp = bindings.filter(binding => binding.name === 'WARP');
  if (restoreMissingWarp && warp.length === 0) warp.push(requiredWarp);
  assert.deepEqual(warp, [requiredWarp], 'Deployment must retain the exact required WARP network');
  const expected = bindings.some(binding => binding.name === 'WARP') ? bindings : [...bindings, requiredWarp];
  return { ...rest, bindings: expected.map(binding => ({ name: binding.name, digest: createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(binding).sort(([a], [b]) => a.localeCompare(b))))).digest('hex') })).sort((a, b) => a.name.localeCompare(b.name)) };
}
