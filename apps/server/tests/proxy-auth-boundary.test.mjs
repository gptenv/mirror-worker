import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-proxy-auth-boundary-'));
process.env.MIRROR_DATA_DIR = dir;
const { proxyChatGpt } = await import('../dist/proxy.js');
const { runWithRequestSessionToken } = await import('../dist/auth.js');
const store = await import('../dist/store.js');

function exchange(url, headers = {}, existingCookie) {
  const state = { headers: {}, status: 200, body: undefined, writes: [] };
  const raw = new EventEmitter();
  raw.writeHead = (status, values) => { state.status = status; Object.assign(state.headers, values); };
  raw.write = chunk => { state.writes.push(Buffer.from(chunk).toString()); return true; };
  raw.end = chunk => { if (chunk) state.writes.push(Buffer.from(chunk).toString()); raw.writableEnded = true; };
  const reply = {
    raw, hijack() {}, getHeader: name => name === 'set-cookie' ? existingCookie : undefined,
    header(name, value) { state.headers[name.toLowerCase()] = value; return this; },
    code(status) { state.status = status; return this; },
    send(body) { state.body = body; return this; },
  };
  const req = { url, method: 'GET', protocol: 'https', headers: { host: 'mirror.example', ...headers }, raw: new EventEmitter(), log: { error() {} } };
  return { req, reply, state };
}

const withCredentials = callback => runWithRequestSessionToken('fixture-access', callback, 'fixture-session', []);

test.describe('server / proxy authentication boundaries', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  test.afterEach(() => test.mock.restoreAll());

  for (const body of ['upstream returned HTML instead of JSON', 'null', '[]', 'false', '{"error":{"message":"profile unavailable"}}']) {
    test(`session projection rejects malformed upstream profile: ${body}`, async t => {
      t.mock.method(globalThis, 'fetch', async input => {
        assert.equal(new URL(String(input)).pathname, '/backend-api/me');
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      });
      const { req, reply, state } = exchange('/api/auth/session');
      await withCredentials(() => assert.rejects(proxyChatGpt(req, reply), error => {
        assert.equal(error.status, 502);
        assert.equal(error.upstreamResponseText, body);
        return true;
      }));
      assert.equal(state.body, undefined, 'malformed identity must not become a browser session');
    });
  }

  for (const [profile, user] of [
    [{}, { id: 'mirror-user', name: 'ChatGPT user', email: null, image: null }],
    [{ id: 'profile-user', account: 'unavailable', name: 'Profile name', email: 'fixture@example.test' }, { id: 'profile-user', name: 'Profile name', email: 'fixture@example.test', image: null }],
    [{ account: { account_user_id: 'account-user', name: 'Account name' }, email: null, image: 'https://example.test/signed?token=fixture' }, { id: 'account-user', name: 'Account name', email: null, image: null }],
  ]) {
    test(`session projection handles optional profile fields for ${user.id}`, async t => {
      t.mock.method(globalThis, 'fetch', async () => Response.json(profile));
      const { req, reply, state } = exchange('/api/auth/session');
      await withCredentials(() => proxyChatGpt(req, reply));
      assert.deepEqual(state.body.user, user);
      assert.equal(state.headers['cache-control'], 'no-store');
      assert.ok(!JSON.stringify(state.body).includes('fixture-access'));
      assert.ok(!JSON.stringify(state.body).includes('token=fixture'));
    });
  }

  test('a first authenticated proxy request resolves its account without creating stored credentials', async t => {
    store.clearSession();
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      requests.push(pathname);
      assert.equal(init.headers.get('authorization'), 'Bearer fixture-access');
      if (pathname === '/backend-api/me') return Response.json({ account: { account_user_id: 'fixture-owner' } });
      assert.equal(pathname, '/backend-api/models');
      assert.equal(init.headers.get('chatgpt-account-id'), 'fixture-owner');
      return Response.json({ models: [] });
    });
    const { req, reply, state } = exchange('/backend-api/models');
    await withCredentials(() => proxyChatGpt(req, reply));
    assert.deepEqual(requests, ['/backend-api/me', '/backend-api/models']);
    assert.equal(store.getSession().accountId, 'fixture-owner');
    assert.ok(!JSON.stringify(store.getSession()).includes('fixture-access'));
    assert.ok(!JSON.stringify(store.getSession()).includes('fixture-session'));
    assert.deepEqual(JSON.parse(state.writes.join('')), { models: [] });
  });

  test('stored owner metadata supplies an account header without another profile lookup', async t => {
    store.saveVerifiedSession('cached-owner', 'fixture-device');
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/backend-api/models');
      assert.equal(init.headers.get('chatgpt-account-id'), 'cached-owner');
      assert.equal(init.headers.get('authorization'), 'Bearer fixture-access');
      return Response.json({ models: [] });
    });
    const { req, reply, state } = exchange('/backend-api/models');
    await withCredentials(() => proxyChatGpt(req, reply));
    assert.deepEqual(JSON.parse(state.writes.join('')), { models: [] });
  });

  for (const authenticated of [false, true]) {
    test(`document request forwards only identity cookies${authenticated ? ' and scoped session' : ''}`, async t => {
      t.mock.method(globalThis, 'fetch', async (input, init) => {
        assert.equal(String(input), 'https://chatgpt.com/');
        assert.equal(init.headers.get('authorization'), null);
        assert.equal(init.headers.get('cookie'), 'oai-did=device-fixture; oai-client-session-epoch=epoch-fixture' + (authenticated ? '; __Secure-next-auth.session-token=fixture-session' : ''));
        return new Response('<html><head></head><body>fixture document</body></html>', { headers: { 'content-type': 'text/html' } });
      });
      const { req, reply } = exchange('/', { accept: 'text/html', cookie: 'mirror_control=private-control; oai-did=device-fixture; __Secure-next-auth.session-token=untrusted-cookie; mirror_asset_session=private-asset; oai-client-session-epoch=epoch-fixture' });
      await runWithRequestSessionToken(authenticated ? 'fixture-access' : undefined, () => proxyChatGpt(req, reply), authenticated ? 'fixture-session' : undefined, []);
    });
  }

  test('upstream identity cookies merge with local cookies when getSetCookie is unavailable', async t => {
    t.mock.method(globalThis, 'fetch', async () => {
      const response = new Response('fixture bytes', { headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'oai-did=device-fixture; Domain=chatgpt.com; Path=/; Secure, __Secure-next-auth.session-token=do-not-store; Path=/, oai-client-session-epoch=epoch-fixture; Domain=.chatgpt.com; Path=/' } });
      Object.defineProperty(response.headers, 'getSetCookie', { value: undefined });
      return response;
    });
    const { req, reply, state } = exchange('/cdn/fixture.png', {}, 'local-fixture=value; Path=/');
    await runWithRequestSessionToken(undefined, () => proxyChatGpt(req, reply), undefined, []);
    assert.deepEqual(state.headers['set-cookie'], ['local-fixture=value; Path=/', 'oai-did=device-fixture; Path=/; Secure', 'oai-client-session-epoch=epoch-fixture; Path=/']);
    assert.ok(!JSON.stringify(state.headers).includes('do-not-store'));
    assert.ok(!JSON.stringify(state.headers).includes('Domain='));
  });

  test('a runtime without getSetCookie leaves an absent upstream cookie absent', async t => {
    t.mock.method(globalThis, 'fetch', async () => {
      const response = new Response('fixture bytes');
      Object.defineProperty(response.headers, 'getSetCookie', { value: undefined });
      return response;
    });
    const { req, reply, state } = exchange('/cdn/fixture.png');
    await runWithRequestSessionToken(undefined, () => proxyChatGpt(req, reply), undefined, []);
    assert.equal(state.headers['set-cookie'], undefined);
  });

  test('a failed proxy session refresh preserves an empty upstream diagnostic and token lengths', async t => {
    t.mock.method(globalThis, 'fetch', async input => new URL(String(input)).pathname === '/api/auth/session'
      ? new Response('', { status: 503 }) : new Response('expired', { status: 401 }));
    const { req, reply, state } = exchange('/backend-api/me');
    await withCredentials(() => proxyChatGpt(req, reply));
    assert.equal(state.status, 503);
    assert.equal(state.body.error.message, '');
    assert.equal(state.body.error.upstream_response_text, '');
    assert.equal(state.body.error.token_lengths.accessToken.received, 'fixture-access'.length);
    assert.equal(state.body.error.token_lengths.sessionToken.received, 'fixture-session'.length);
    assert.ok(!JSON.stringify(state.body).includes('fixture-session'));
  });

  test('a proxy transport error keeps its message without inventing an upstream body', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('synthetic binding transport failed'); });
    const { req, reply, state } = exchange('/cdn/fixture.png');
    await runWithRequestSessionToken(undefined, () => proxyChatGpt(req, reply), undefined, []);
    assert.equal(state.status, 502);
    assert.equal(state.body.error.message, 'synthetic binding transport failed');
    assert.equal(state.body.error.upstream_response_text, undefined);
    assert.equal(state.body.error.token_lengths, undefined);
  });

  test('a transport promise rejected without an Error still returns a stable diagnostic', async t => {
    t.mock.method(globalThis, 'fetch', () => Promise.reject());
    const { req, reply, state } = exchange('/cdn/fixture.png');
    await runWithRequestSessionToken(undefined, () => proxyChatGpt(req, reply), undefined, []);
    assert.equal(state.status, 502);
    assert.deepEqual(state.body.error, {
      type: 'upstream_request_failed',
      message: 'The upstream request failed before a response was received.',
      path: '/cdn/fixture.png',
    });
  });
});
