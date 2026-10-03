import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolDefinitions, selectToolDefinitions, toolBridgePrompt, parseToolBridgeAnswer } from '../dist/tool-bridge.js';

test.describe('server / tool bridge', () => {
  const tools = validateToolDefinitions([{ type: 'function', function: {
    name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } },
  } }]);
  test('prompts with tool definitions and prior tool results', () => {
    const prompt = toolBridgePrompt([{ role: 'tool', tool_call_id: 'call_1', content: 'file data' }], tools, 'auto');
    assert.match(prompt, /read_file/);
    assert.match(prompt, /file data/);
  });
  test('returns OpenAI shaped tool calls with JSON argument strings', () => {
    const answer = parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}', tools, 'auto');
    assert.equal(answer.content, null);
    assert.match(answer.toolCalls[0].id, /^call_/);
    assert.equal(answer.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  });
  test('accepts a final answer after tool results', () => {
    assert.deepEqual(parseToolBridgeAnswer('{"content":"done"}', tools, 'auto'), { content: 'done' });
  });
  test('rejects unknown functions and invalid arguments', () => {
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"shell","arguments":{}}]}', tools, 'auto'), /unknown function/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":"bad"}]}', tools, 'auto'), /invalid function arguments/);
  });
  test('accepts a large OpenCode catalog without dropping tools', () => {
    const catalog = Array.from({ length: 1200 }, (_, index) => ({ type: 'function', function: {
      name: `tool_${index}`, parameters: { type: 'object' },
    } }));
    const validated = validateToolDefinitions(catalog);
    assert.equal(validated.length, catalog.length);
    assert.equal(validated.at(-1).function.name, 'tool_1199');
  });
  test('selects a relevant schema from a large catalog within the prompt budget', () => {
    const catalog = validateToolDefinitions(Array.from({ length: 400 }, (_, index) => ({ type: 'function', function: {
      name: index === 399 ? 'read_file' : `unrelated_${index}`,
      description: index === 399 ? 'Read a project file' : 'Unrelated service operation with a long description '.repeat(8),
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    } })));
    const selected = selectToolDefinitions([{ role: 'user', content: 'Read a project file' }], catalog, 'auto');
    assert.ok(selected.some(tool => tool.function.name === 'read_file'));
    assert.ok(selected.length < catalog.length);
    assert.ok(JSON.stringify(selected).length <= 12_000);
    assert.match(toolBridgePrompt([{ role: 'user', content: 'Read a project file' }], selected, 'auto'), /read_file/);
  });
});
