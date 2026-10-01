import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-upstream-error-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
const { upstreamErrorMessage } = await import('../dist/api-errors.js');
test.describe('server / upstream-error-body', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = '{\n  "error": {"message":"upstream denied", "detail":"more context", "code":"account_denied"}\n}\n';
  test('preserves complete JSON, HTML, plain text and empty upstream bodies', () => {
    for (const value of [body, '<html>denied</html>\n', 'denied\n', '']) assert.equal(upstreamErrorMessage(value), value);
  });
  for (const stream of [false, true]) test(`${stream ? 'streaming' : 'JSON'} completions expose the exact upstream body inside the OpenAI error envelope`, async () => {
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 403, headers: { 'content-type': 'application/json' } }));
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer test-access' },
        payload: { messages: [{ role: 'user', content: 'hello' }], store: false, stream } });
      const envelope = stream
        ? response.body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).find(chunk => chunk.error)
        : response.json();
      assert.equal(envelope.error.message, body);
      assert.equal(envelope.error.type, 'permission_error');
      assert.equal(envelope.error.code, 'request_forbidden');
      assert.ok(envelope.error.request_id);
      if (!stream) assert.equal(response.statusCode, 403);
    } finally { test.mock.restoreAll(); await app.close(); }
  });
});
