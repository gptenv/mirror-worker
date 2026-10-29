import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { stubBackend, assistantAddFrame } from './helpers/backend.mjs';
const dir = mkdtempSync(path.join(tmpdir(), 'mirror-tool-calls-'));
process.env.MIRROR_DATA_DIR = dir;
process.env.MIRROR_API_KEY = 'fixture-access';
const store = await import('../dist/store.js');
const { registerOpenAiRoutes } = await import('../dist/openai.js');
const app = Fastify();
await registerOpenAiRoutes(app);
const originalFetch = globalThis.fetch;
const tools = [{ type: 'function', function: { name: 'weather', description: 'Get weather', parameters: { type: 'object' } } }];
let counter = 0;
async function request(text, extra = {}) {
  store.saveVerifiedSession(`tool-account-${counter++}`, 'fixture-device');
  globalThis.fetch = stubBackend('fixture-account', { turnFrames: body => [assistantAddFrame(body.conversation_id ?? 'upstream', 'assistant', text), '[DONE]'] });
  return app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [{ role: 'user', content: 'weather?' }], tools, stream: false, ...extra } });
}
test.describe('server / client tool calls', () => {
  test.after(async () => { globalThis.fetch = originalFetch; await app.close(); rmSync(dir, { recursive: true, force: true }); });
  test('turns a valid generated call into an OpenAI tool_calls response', async () => {
    const response = await request('```json\n{"tool_calls":[{"id":"call-1","function":{"name":"weather","arguments":{"city":"Toronto"}}}]}\n```');
    assert.equal(response.statusCode, 200, response.body);
    const choice = response.json().choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.deepEqual(choice.message.tool_calls, [{ id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{"city":"Toronto"}' } }]);
    assert.equal(choice.message.content, null);
  });
  test('rejects invalid required calls without inventing executable tool input', async () => {
    for (const text of ['ordinary answer', '{}', '{"tool_calls":[]}', '{"tool_calls":[{"name":"unknown","arguments":{}}]}', '{"tool_calls":[{"name":"weather","arguments":"not-json"}]}', '{"tool_calls":[{"name":"weather","arguments":[]}]}']) {
      const response = await request(text, { tool_choice: 'required' });
      assert.equal(response.statusCode, 502, response.body);
    }
  });
  test('ordinary output with automatic selection stays text', async () => {
    const response = await request('A sunny day.', { tool_choice: 'auto' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].message.content, 'A sunny day.');
  });
  test('JSON without tool calls remains an ordinary answer under automatic selection', async () => {
    const response = await request('{"answer":"sunny"}', { tool_choice: 'auto' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].message.content, '{"answer":"sunny"}');
  });
  test('a new-conversation command starts a fresh thread and rejects an empty prompt', async () => {
    store.saveVerifiedSession('new-command-account', 'fixture-device');
    globalThis.fetch = stubBackend('new-command-account');
    const post = content => app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [{ role: 'user', content }], stream: false } });
    const first = await post('first');
    const next = await post('/new second');
    assert.equal(next.statusCode, 200, next.body);
    assert.notEqual(next.headers['x-mirror-conversation-id'], first.headers['x-mirror-conversation-id']);
    assert.equal((await post('/new')).statusCode, 400);
  });
  test('tool results are sent as input with their call identifiers', async () => {
    store.saveVerifiedSession('tool-result-account', 'fixture-device');
    const sent = [];
    globalThis.fetch = stubBackend('tool-result-account', { sent });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {
      stream: false, tools, messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', name: 'weather', content: 'sunny' },
      ],
    } });
    assert.equal(response.statusCode, 200, response.body);
    const turn = sent.find(item => item.pathname.endsWith('/f/conversation'));
    assert.match(JSON.stringify(turn.body), /call-1/);
    assert.match(JSON.stringify(turn.body), /sunny/);
  });
  test('enforces selection and parallel-call restrictions', async () => {
    const call = { name: 'weather', arguments: { city: 'Toronto' } };
    const multi = await request(JSON.stringify({ tool_calls: [call, call] }), { parallel_tool_calls: false });
    assert.equal(multi.statusCode, 502, multi.body);
    const none = await request(JSON.stringify({ tool_calls: [call] }), { tool_choice: 'none' });
    assert.equal(none.statusCode, 502, none.body);
    const required = await request(JSON.stringify({ tool_calls: [call] }), { tool_choice: { type: 'function', function: { name: 'weather' } } });
    assert.equal(required.statusCode, 200, required.body);
    assert.match(required.json().choices[0].message.tool_calls[0].id, /^call_/);
  });
  test('streams a tool call with a terminal tool_calls finish reason', async () => {
    const response = await request(JSON.stringify({ tool_calls: [{ name: 'weather', arguments: '{"city":"Ottawa"}' }] }), { stream: true });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"tool_calls"/);
    assert.match(response.body, /"finish_reason":"tool_calls"/);
    assert.match(response.body, /\[DONE\]/);
  });
});
