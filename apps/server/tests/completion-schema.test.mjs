import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionBody } from '../dist/openai.js';

test.describe('server / completion-schema', () => {
  const message = { messages: [{ role: 'user', content: 'Hello' }] };
  test('accepts standard temperatures and null for compatibility', () => {
    for (const temperature of [0, 0.7, 1, 2, null]) {
      const parsed = CompletionBody.parse({ ...message, temperature });
      assert.equal(parsed.temperature, temperature);
    }
    assert.equal(CompletionBody.parse(message).temperature, undefined);
  });
  test('rejects out-of-range and nonnumeric temperatures', () => {
    for (const temperature of [-0.1, 2.1, '0.7', true, NaN, Infinity]) {
      const result = CompletionBody.safeParse({ ...message, temperature });
      assert.equal(result.success, false);
      assert.deepEqual(result.error.issues[0].path, ['temperature']);
    }
  });
  test('keeps validation strict for unsupported fields', () => {
    assert.equal(CompletionBody.safeParse({ ...message, temperature: 0.7, unknown_option: true }).success, false);
  });
});
