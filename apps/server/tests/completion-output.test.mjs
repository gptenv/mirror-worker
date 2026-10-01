import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGptBackendClient } from '@mirror/protocol';
import { stubBackend } from './helpers/backend.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-completion-output-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
test.describe('server / completion-output', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  async function request(stream, result) {
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', stubBackend('output-test'));
    if (result) test.mock.method(ChatGptBackendClient.prototype, 'sendMessage', async () => ({
      conversationId: 'upstream-test', messageId: 'assistant-test', userMessageId: 'user-test', status: 'done', events: [], ...result,
    }));
    try {
      return await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-access' },
        payload: { messages: [{ role: 'user', content: 'hello' }], stream, store: false, temperature: 0.7 } });
    } finally { test.mock.restoreAll(); await app.close(); }
  }
  test('control chunks omit content and the answer contains actual text', async () => {
    const response = await request(true);
    assert.equal(response.statusCode, 200, response.body);
    const frames = response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    const chunks = frames.filter(frame => frame !== '[DONE]').map(frame => JSON.parse(frame));
    assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });
    assert.ok(chunks.some(chunk => chunk.choices?.[0]?.delta?.content === 'reply-1'));
    assert.ok(chunks.every(chunk => chunk.choices?.[0]?.delta?.content !== ''));
    assert.equal(frames.at(-1), '[DONE]');
  });
  test('streams final text even when there were no text callbacks', async () => {
    const response = await request(true, { text: 'final-only answer' });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"content":"final-only answer"/);
    assert.match(response.body, /data: \[DONE\]/);
  });
  test('empty completed answers become errors, with a terminal marker for streaming clients', async () => {
    const json = await request(false, { text: '' });
    assert.equal(json.statusCode, 502, json.body);
    assert.equal(json.json().error.type, 'server_error');
    assert.equal(json.json().error.code, 'empty_completion');
    assert.match(json.json().error.message, /without returning an assistant answer/);
    const stream = await request(true, { text: '' });
    assert.match(stream.body, /"error":/);
    assert.match(stream.body, /"type":"server_error"/);
    assert.ok(stream.body.endsWith('data: [DONE]\n\n'));
    assert.doesNotMatch(stream.body, /"finish_reason":"stop"/);
  });
});
