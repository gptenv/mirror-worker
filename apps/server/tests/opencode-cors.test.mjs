import assert from 'node:assert/strict';
import test from 'node:test';

const { buildApp } = await import('../dist/index.js');

test.describe('server / OpenCode CORS', () => {
  test('OpenCode request headers pass the public API CORS preflight', async () => {
    const app = await buildApp({ worker: true });
    try {
      const origin = 'https://desktop.example';
      const requested = ['authorization', 'content-type', 'x-session-affinity', 'x-session-id', 'x-parent-session-id'];
      const response = await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions', headers: {
        host: 'localhost', origin, 'access-control-request-method': 'POST',
        'access-control-request-headers': requested.join(','),
      } });
      assert.equal(response.statusCode, 204);
      assert.equal(response.headers['access-control-allow-origin'], origin);
      const allowed = response.headers['access-control-allow-headers'].toLowerCase().split(/,\s*/);
      for (const header of requested) assert.ok(allowed.includes(header), `${header} is missing`);
    } finally {
      await app.close();
    }
  });
});
