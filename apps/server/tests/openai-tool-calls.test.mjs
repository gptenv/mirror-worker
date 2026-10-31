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
        { role: 'tool', tool_call_id: 'call-2', name: 'weather', content: 'warm' },
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
  test('ignores empty catalog placeholders while accepting legacy named entries', async () => {
    const response = await request('{"tool_calls":[{"name":"weather"}]}', {
      tools: [null, false, '', '  ', [], {}, { name: 'weather' }],
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].message.tool_calls[0].function.arguments, '{}');
    const plain = await request('ordinary answer', { tools: [null, '', [], {}] });
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal(plain.json().choices[0].message.content, 'ordinary answer');
  });
  test('named choices fail closed for malformed, mismatched and missing calls', async () => {
    const tool_choice = { type: 'function', function: { name: 'weather' } };
    for (const text of ['not JSON', 'null', '{"tool_calls":[]}', '{"tool_calls":[null]}', '{"tool_calls":[{"name":"other","arguments":{}}]}']) {
      const response = await request(text, { tool_choice });
      assert.equal(response.statusCode, 502, response.body);
      assert.ok(response.json().error);
    }
    const malformed = await request('{"tool_calls":[{"name":"weather","arguments":"null"}]}');
    assert.equal(malformed.statusCode, 502, malformed.body);
  });
  test('an isolated tool result can continue without fabricating an assistant call', async () => {
    store.saveVerifiedSession('standalone-tool-account', 'fixture-device');
    const sent = [];
    globalThis.fetch = stubBackend('standalone-tool-account', { sent });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {
      stream: false, tools, messages: [{ role: 'tool', tool_call_id: 'prior-call', content: 'result from caller' }],
    } });
    assert.equal(response.statusCode, 200, response.body);
    const turn = sent.find(item => item.pathname.endsWith('/f/conversation'));
    assert.match(JSON.stringify(turn.body), /prior-call/);
    assert.match(JSON.stringify(turn.body), /result from caller/);
  });
  test('compatible minimal turns resume the saved account conversation and retain instructions', async () => {
    store.saveVerifiedSession('implicit-account', 'fixture-device');
    globalThis.fetch = stubBackend('implicit-account');
    const post = messages => app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages, model: 'auto', stream: false } });
    const first = await post([{ role: 'system', content: 'Keep answers short' }, { role: 'user', content: 'first' }]);
    assert.equal(first.statusCode, 200, first.body);
    const id = first.headers['x-mirror-conversation-id'];
    const second = await post([{ role: 'user', content: 'second' }]);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.headers['x-mirror-conversation-id'], id);
    assert.equal(store.getInstructions(id)[0].content, 'Keep answers short');
    const third = await post([{ role: 'system', content: 'Use complete sentences' }, { role: 'user', content: 'third' }]);
    assert.equal(third.statusCode, 200, third.body);
    assert.equal(third.headers['x-mirror-conversation-id'], id);
    assert.equal(store.getInstructions(id)[0].content, 'Use complete sentences');
    const fourth = await post([{ role: 'developer', content: 'Use precise wording' }, { role: 'user', content: 'fourth' }]);
    assert.equal(fourth.statusCode, 200, fourth.body);
    assert.equal(fourth.headers['x-mirror-conversation-id'], id);
    assert.equal(store.getInstructions(id)[0].role, 'developer');
    assert.equal(store.getInstructions(id)[0].content, 'Use precise wording');
  });

  test('generic non-empty catalog entries preserve the generated call shape', async () => {
    const response = await request('{"tool_calls":[{"name":"weather","arguments":{}}]}', { tools: ['weather tool', ['weather'], 1, { description: 'weather tool' }] });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].message.tool_calls[0].function.name, 'weather');
  });
  test('model, gizmo and privacy changes do not silently reuse incompatible implicit conversations', async () => {
    for (const [initial, matching, different] of [
      [{ model: 'model-a' }, { model: 'model-a' }, { model: 'model-b' }],
      [{ model: 'g-weather' }, { model: 'g-weather' }, { model: 'g-other' }],
      [{ metadata: { private: 'true' } }, { metadata: { private: 'true' } }, { metadata: { private: 'false' } }],
    ]) {
      const account = `implicit-route-${counter++}`;
      store.saveVerifiedSession(account, 'fixture-device');
      const backend = stubBackend(account);
      globalThis.fetch = (url, init) => new URL(String(url)).pathname.startsWith('/backend-api/gizmos/')
        ? Promise.resolve(Response.json({ gizmo: { id: new URL(String(url)).pathname.split('/').at(-1) } }))
        : backend(url, init);
      const post = config => app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [{ role: 'user', content: 'next' }], stream: false, ...config } });
      const first = await post(initial);
      assert.equal(first.statusCode, 200, first.body);
      const next = await post(matching);
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(next.headers['x-mirror-conversation-id'], first.headers['x-mirror-conversation-id']);
      const changed = await post(different);
      assert.equal(changed.statusCode, 200, changed.body);
      assert.notEqual(changed.headers['x-mirror-conversation-id'], first.headers['x-mirror-conversation-id']);
    }
  });

});
