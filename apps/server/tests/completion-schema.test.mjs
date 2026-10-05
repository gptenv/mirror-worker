import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionBody } from '../dist/openai.js';
import { ResponsesBody } from '../dist/responses.js';

test.describe('server / completion-schema', () => {
  const message = { messages: [{ role: 'user', content: 'Hello' }] };
  test('accepts standard temperatures and null for compatibility', () => {
    for (const temperature of [0, 0.7, 1, 2, null]) {
      const parsed = CompletionBody.parse({ ...message, temperature });
      assert.equal(parsed.temperature, temperature);
    }
    assert.equal(CompletionBody.parse(message).temperature, undefined);
  });
  test('streams by default but honors an explicit opt-out', () => {
    assert.equal(CompletionBody.parse(message).stream, true);
    assert.equal(CompletionBody.parse({ ...message, stream: false }).stream, false);
    assert.equal(ResponsesBody.parse({ input: 'Hello' }).stream, true);
    assert.equal(ResponsesBody.parse({ input: 'Hello', stream: false }).stream, false);
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
  test('accepts non-tool streaming and reasoning compatibility fields', () => {
    const parsed = CompletionBody.parse({ ...message, stream: true,
      stream_options: { include_usage: true }, reasoning_effort: 'high' });
    assert.equal(parsed.stream_options.include_usage, true);
    assert.equal(parsed.reasoning_effort, 'high');
  });
});
