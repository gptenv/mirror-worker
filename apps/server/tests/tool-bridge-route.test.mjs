import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGptBackendClient } from '@mirror/protocol';
import { stubBackend } from './helpers/backend.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-tool-bridge-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
const store = await import('../dist/store.js');
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

test.describe('server / tool bridge route', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  async function request(stream, text, messages = [{ role: 'user', content: 'Read a.txt' }], poisonedRequestSignal = false, requestTools = tools) {
    const app = await buildApp({ worker: true });
    if (poisonedRequestSignal) app.addHook('onRequest', async req => {
      // A request-body signal is not the response-stream lifetime. A bridge
      // adapter can expose an already-completed upload signal here.
      req.raw.signal = AbortSignal.abort(new DOMException('Upload complete', 'AbortError'));
    });
    test.mock.method(globalThis, 'fetch', stubBackend('tool-bridge-test'));
    test.mock.method(ChatGptBackendClient.prototype, 'sendMessage', async () => ({
      conversationId: 'upstream-test', messageId: 'assistant-test', userMessageId: 'user-test', status: 'done', events: [], text,
    }));
    try {
      return await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-access' },
        payload: { messages, tools: requestTools, stream, stream_options: { include_usage: true }, reasoning_effort: 'high' } });
    } finally { test.mock.restoreAll(); await app.close(); }
  }
  test('returns a nonstreamed function request', async () => {
    const response = await request(false, '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].finish_reason, 'tool_calls');
    assert.equal(response.json().choices[0].message.tool_calls[0].function.name, 'read_file');
  });
  test('streams a function request and accepts the following tool result', async () => {
    const response = await request(true, '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}');
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"finish_reason":"tool_calls"/);
    assert.match(response.body, /data: \[DONE\]/);
    const next = await request(false, '{"content":"The file says hello."}', [
      { role: 'user', content: 'Read a.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
    ]);
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().choices[0].message.content, 'The file says hello.');
  });
  test('does not cancel generation when the incoming request signal is already aborted', async () => {
    const response = await request(true, '{"content":"ready"}', undefined, true);
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"content":"ready"/);
    assert.match(response.body, /data: \[DONE\]/);
  });
  test('streams a final answer with hundreds of client tools', async () => {
    const catalog = Array.from({ length: 400 }, (_, index) => ({ type: 'function', function: {
      name: `service_${index}`, description: 'An unrelated service operation '.repeat(10),
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    } }));
    const response = await request(true, '{"content":"OK"}', [{ role: 'user', content: 'Reply with exactly OK.' }], false, catalog);
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"content":"OK"/);
    assert.match(response.body, /data: \[DONE\]/);
  });
  test('keeps OpenCode turns in one non-temporary upstream conversation', async () => {
    const app = await buildApp({ worker: true });
    const turns = [];
    test.mock.method(globalThis, 'fetch', stubBackend('tool-bridge-persistent'));
    test.mock.method(ChatGptBackendClient.prototype, 'sendMessage', async opts => {
      turns.push(opts);
      return { conversationId: 'upstream-persistent', messageId: `assistant-${turns.length}`,
        userMessageId: `user-${turns.length}`, status: 'done', events: [], text: '{"content":"OK"}' };
    });
    try {
      for (const content of ['First turn', 'Second turn']) {
        const response = await app.inject({ method: 'POST', url: '/v1/chat/completions',
          headers: { authorization: 'Bearer fixture-access', 'x-session-id': 'ses-persistent' },
          payload: { model: 'gpt-5-6', messages: [{ role: 'user', content }], tools } });
        assert.equal(response.statusCode, 200, response.body);
      }
      assert.equal(turns.length, 2);
      assert.equal(turns[0].historyAndTrainingDisabled, false);
      assert.equal(turns[1].historyAndTrainingDisabled, false);
      assert.equal(turns[1].conversationId, 'upstream-persistent');
      const id = `opencode-${store.fingerprintValue(['default', 'ses-persistent'])}`;
      const conversation = store.getConversation(id);
      assert.equal(conversation.private, false);
      assert.equal(conversation.conversationId, 'upstream-persistent');
      assert.equal(store.listMessages(id).length, 4);
    } finally { test.mock.restoreAll(); await app.close(); }
  });
});
