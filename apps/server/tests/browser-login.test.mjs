import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-browser-login-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
const { BROWSER_BOOTSTRAP } = await import('../dist/browser-bootstrap.js');

test.describe('server / browser-login', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('navigation loads credentials from browser storage and preserves rotation before rendering', async () => {
    const storage = new Map([['mirror_access_token', 'session-' + 'x'.repeat(24000)]]);
    let written;
    const context = {
      Headers, location: { href: 'https://mirror.example/c/abc' },
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      fetch: async (url, init) => {
        assert.equal(url, context.location.href);
        assert.equal(init.headers.get('authorization'), 'Bearer ' + storage.get('mirror_access_token'));
        assert.equal(init.headers.get('x-mirror-document'), '1');
        return new Response('<html>authenticated</html>', { headers: { 'x-mirror-access-token': 'access-new', 'x-mirror-session-token': 'session-new' } });
      },
      document: { open() {}, write(html) { written = html; }, close() {}, getElementById() { throw Error('unexpected error'); } },
    };
    await vm.runInNewContext(BROWSER_BOOTSTRAP.match(/<script>([\s\S]*)<\/script>/)[1], context);
    assert.equal(written, '<html>authenticated</html>');
    assert.equal(storage.get('mirror_access_token'), 'access-new');
    assert.equal(storage.get('mirror_session_token'), 'session-new');
  });

  test('Worker browser navigation bootstraps without granting access to account data', async () => {
    const app = await buildApp({ worker: true });
    try {
      const page = await app.inject({ url: '/', headers: { accept: 'text/html' } });
      assert.equal(page.statusCode, 200);
      assert.equal(page.body, BROWSER_BOOTSTRAP);
      assert.equal(page.headers['set-cookie'], undefined);
      const privateData = await app.inject({ url: '/api/conversations' });
      assert.equal(privateData.statusCode, 401);
      const controls = await app.inject({ url: '/mirror/inject.js' });
      assert.equal(controls.statusCode, 200);
    } finally { await app.close(); }
  });

  test('authenticated document uses the rotated session cookie and returns rotated credentials to the browser', async () => {
    const app = await buildApp({ worker: true });
    const calls = [];
    const sessionToken = 'session-' + 'x'.repeat(24000);
    try {
      const fetchMock = test.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(input); calls.push(url);
        if (url.endsWith('/backend-api/me')) {
          if (new Headers(init.headers).get('authorization') === 'Bearer ' + sessionToken)
            return new Response('access denied', { status: 401 });
          return Response.json({ id: 'user-test', email: 'test@example.com' });
        }
        if (url.endsWith('/api/auth/session')) {
          assert.equal(new Headers(init.headers).get('cookie'), '__Secure-next-auth.session-token=' + sessionToken);
          return Response.json({ accessToken: 'access-new' }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=session-new; Path=/' } });
        }
        assert.equal(url, 'https://chatgpt.com/');
        assert.equal(new Headers(init.headers).get('cookie'), '__Secure-next-auth.session-token=session-new');
        const headers = new Headers({ 'content-type': 'text/html' });
        headers.append('set-cookie', 'oai-client-session-epoch=epoch-test; Domain=chatgpt.com; Path=/; Secure');
        headers.append('set-cookie', '__Secure-next-auth.session-token=must-not-store; Path=/; Secure');
        return new Response('<html><head></head><body>logged in</body></html>', { headers });
      });
      const response = await app.inject({ url: '/', headers: { accept: 'text/html', authorization: 'Bearer ' + sessionToken, 'x-mirror-document': '1' } });
      fetchMock.mock.restore();
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.body, /logged in/);
      assert.equal(response.headers['x-mirror-access-token'], 'access-new');
      assert.equal(response.headers['x-mirror-session-token'], 'session-new');
      assert.deepEqual(response.headers['set-cookie'], ['oai-client-session-epoch=epoch-test; Path=/; Secure']);
      assert.ok(calls.includes('https://chatgpt.com/'));
    } finally { test.mock.restoreAll(); await app.close(); }
  });

  test('desktop API aliases preserve the query, bearer and account headers without extra session exchanges', async () => {
    const app = await buildApp({ worker: true });
    const calls = [];
    const paths = ['/me', '/accounts/check/v4-2023-04-27?timezone_offset_min=-240', '/models', '/conversations?limit=28'];
    test.mock.method(globalThis, 'fetch', async (input, init) => {
      calls.push(String(input));
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer stored-access');
      assert.equal(headers.get('chatgpt-account-id'), 'account-test');
      assert.equal(headers.get('x-openai-target-path'), new URL(String(input)).pathname);
      return Response.json({ ok: true });
    });
    try {
      for (const path of paths) {
        const response = await app.inject({ url: '/__codex-api' + path, headers: {
          authorization: 'Bearer stored-access', 'x-mirror-session-token': 'stored-session', 'chatgpt-account-id': 'account-test',
        } });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), { ok: true });
      }
      assert.deepEqual(calls, paths.map(path => 'https://chatgpt.com/backend-api' + path));
    } finally { test.mock.restoreAll(); await app.close(); }
  });

  test('native asset loads skip credential validation and missing Mirror assets reach ChatGPT', async () => {
    const app = await buildApp({ worker: true, assets: { fetch: async () => new Response('missing', { status: 404 }) } });
    const calls = [];
    test.mock.method(globalThis, 'fetch', async (input) => {
      calls.push(String(input));
      return new Response('/* upstream asset */', { headers: { 'content-type': 'application/javascript' } });
    });
    try {
      for (const path of ['/cdn/assets/async/chunk.js', '/unauth-mweb/assets/client.js', '/assets/upstream.js']) {
        const response = await app.inject({ url: path, headers: { authorization: 'Bearer header-extension-session' } });
        assert.equal(response.statusCode, 200, response.body);
      }
      assert.deepEqual(calls, ['https://chatgpt.com/cdn/assets/async/chunk.js', 'https://chatgpt.com/unauth-mweb/assets/client.js', 'https://chatgpt.com/assets/upstream.js']);
    } finally { test.mock.restoreAll(); await app.close(); }
  });
});
