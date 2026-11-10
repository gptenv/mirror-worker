import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stubBackend } from './helpers/backend.mjs';
const dir = mkdtempSync(path.join(tmpdir(), 'mirror-session-delivery-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
const { runWithRequestSessionToken } = await import('../dist/auth.js');
const store = await import('../dist/store.js');

test.describe('server / session delivery', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const routes = [
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'fixture' }], stream: true }],
    ['/v1/responses', { input: 'fixture', stream: true }],
    ['/api/chat?fixture=1', { prompt: 'fixture' }],
  ];
  for (const owner of [true, false]) for (const [url, payload] of routes) test(`${url} delivers settled rotation before SSE (owner=${owner})`, async t => {
    store.saveVerifiedSession('fixture-owner');
    let mints = 0;
    const backend = stubBackend('fixture-owner');
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const headers = new Headers(init?.headers);
      if (pathname === '/api/auth/session') {
        mints++;
        return Response.json({ accessToken: 'fresh' }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=fresh-session; Path=/' } });
      }
      if (headers.get('authorization') === 'Bearer expired') return new Response('expired', { status: 401 });
      if (pathname === '/backend-api/me') return Response.json({ object: 'user', id: 'fixture-owner' });
      return backend(input, init);
    });
    const app = await buildApp({ worker: true, ...(owner ? { ownerUserId: 'fixture-owner' } : {}) });
    try {
      const response = await runWithRequestSessionToken('expired', () => app.inject({ method: 'POST', url, payload,
        headers: { authorization: 'Bearer expired', 'x-mirror-session-token': 'old-session' } }), 'old-session', []);
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.headers['content-type'], /text\/event-stream/);
      assert.equal(response.headers['x-mirror-access-token'], 'fresh');
      assert.equal(response.headers['x-mirror-session-token'], 'fresh-session');
      assert.match(response.headers['cache-control'], /no-store/);
      assert.ok(response.headers['x-request-id']);
      assert.doesNotMatch(response.body, /fresh-session|"error":\{/);
      assert.equal(mints, 1);
    } finally { await app.close(); }
  });
  test('owner refresh is retained on document failure but withheld from rejected identities', async t => {
    let identity = 'owner', mints = 0;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      if (new URL(String(input)).pathname === '/api/auth/session') {
        mints++;
        return Response.json({ accessToken: 'fresh' }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=fresh-session; Path=/' } });
      }
      if (new Headers(init.headers).get('authorization') !== 'Bearer fresh') return new Response('expired', { status: 401 });
      return Response.json({ object: 'user', id: identity });
    });
    const app = await buildApp({ worker: true, ownerUserId: 'owner', assets: { fetch: async () => new Response('unavailable', { status: 503 }) } });
    try {
      for (identity of ['owner', 'other', 'owner']) {
        const response = await runWithRequestSessionToken('expired', () => app.inject({ url: '/mirror/playground',
          headers: { authorization: 'Bearer expired', accept: 'text/html', 'x-mirror-document': '1' } }), undefined, []);
        assert.equal(response.statusCode, identity === 'owner' ? 503 : 403);
        assert.equal(response.headers['x-mirror-auth-status'], identity === 'owner' ? 'owner_verified' : 'owner_mismatch');
        assert.equal(response.headers['x-mirror-access-token'], identity === 'owner' ? 'fresh' : undefined);
        assert.equal(response.headers['x-mirror-session-token'], identity === 'owner' ? 'fresh-session' : undefined);
      }
      assert.equal(mints, 3, 'each request independently refreshes and verifies ownership');
    } finally { await app.close(); }
  });
  for (const owner of [true, false]) for (const status of [403, 429, 503, 'network', 'malformed']) test(`credential validation preserves upstream failure ${status} (owner=${owner})`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (status === 'network') throw Error('network unavailable');
      if (status === 'malformed') return new Response('not JSON');
      return new Response('edge unavailable', { status });
    });
    const app = await buildApp({ worker: true, ...(owner ? { ownerUserId: 'owner' } : {}) });
    try {
      const response = await app.inject({ url: '/api/diagnostics', headers: { authorization: 'Bearer fixture' } });
      assert.equal(response.statusCode, typeof status === 'number' ? status : 502);
      assert.equal(response.json().error.type, 'upstream_error');
      assert.equal(response.headers['x-mirror-auth-status'], 'upstream_failure');
      assert.equal(calls, 1, 'no retries for ambiguous or transient failures');
    } finally { await app.close(); }
  });
  test('a downstream denial cannot rotate or switch identity after the owner gate', async t => {
    let mints = 0, posts = 0;
    const backend = stubBackend('owner');
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/auth/session') { mints++; return Response.json({ accessToken: 'other-owner' }); }
      if (pathname === '/backend-api/me') return Response.json({ object: 'user', id: 'owner' });
      if (pathname === '/backend-api/f/conversation') { posts++; return new Response('expired', { status: 401 }); }
      return backend(input, init);
    });
    const app = await buildApp({ worker: true, ownerUserId: 'owner' });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: routes[0][1], headers: { authorization: 'Bearer fixture' } });
      assert.match(response.body, /"error":/);
      assert.equal(mints, 0);
      assert.equal(posts, 1, 'generation is not replayed');
      assert.equal(response.headers['x-mirror-access-token'], undefined);
    } finally { await app.close(); }
  });
  test('proxied document errors carry local verification and reject forged auth headers', async t => {
    let refresh = true;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/auth/session') return Response.json({ accessToken: 'fresh' }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=rotated; Path=/' } });
      if (pathname === '/backend-api/me') {
        if (refresh && new Headers(init.headers).get('authorization') !== 'Bearer fresh') return new Response('expired', { status: 401 });
        return Response.json({ object: 'user', id: 'owner' });
      }
      return new Response('document unavailable', { status: 503, headers: { 'x-mirror-auth-status': 'owner_mismatch',
        'x-mirror-access-token': 'forged', 'x-mirror-session-token': 'forged', 'cache-control': 'public' } });
    });
    const app = await buildApp({ worker: true, ownerUserId: 'owner' });
    try {
      for (refresh of [true, false]) {
        const response = await runWithRequestSessionToken('fixture', () => app.inject({ url: '/', headers: { authorization: 'Bearer fixture', 'x-mirror-document': '1', accept: 'text/html' } }), undefined, []);
        assert.equal(response.statusCode, 503);
        assert.equal(response.headers['x-mirror-auth-status'], 'owner_verified');
        assert.equal(response.headers['x-mirror-access-token'], refresh ? 'fresh' : undefined);
        assert.equal(response.headers['x-mirror-session-token'], refresh ? 'rotated' : undefined);
        if (refresh) assert.equal(response.headers['cache-control'], 'no-store');
      }
    } finally { await app.close(); }
  });

  test('local explicit rejection marks credentials rejected', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('invalid credential', { status: 401 }));
    const app = await buildApp({ worker: true });
    try {
      const response = await app.inject({ url: '/api/diagnostics', headers: { authorization: 'Bearer fixture' } });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['x-mirror-auth-status'], 'credential_rejected');
    } finally { await app.close(); }
  });
  test('Node control-cookie streams seal the configured credentials and fail without any', async t => {
    const { controlCookie } = await import('../dist/security.js');
    const previous = process.env.MIRROR_API_KEY;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async input => {
      assert.ok(!String(input).endsWith('/api/auth/session'), 'sealed configured credentials must not mint again');
      return ++calls === 1 ? Response.json({}) : new Response('expired', { status: 401 });
    });
    const app = await buildApp();
    try {
      for (const configured of [true, false]) {
        if (configured) process.env.MIRROR_API_KEY = 'fixture-configured';
        else delete process.env.MIRROR_API_KEY;
        const response = await runWithRequestSessionToken(undefined, () => app.inject({ method: 'POST', url: '/api/chat',
          headers: { cookie: controlCookie() }, payload: { prompt: 'fixture' } }));
        assert.equal(response.statusCode, configured ? 200 : 401, response.body);
      }
    } finally { await app.close(); if (previous === undefined) delete process.env.MIRROR_API_KEY; else process.env.MIRROR_API_KEY = previous; }
  });

  test('pre-stream authentication respects deadlines before committing SSE', async t => {
    const previous = process.env.MIRROR_IDLE_TIMEOUT_MS;
    process.env.MIRROR_IDLE_TIMEOUT_MS = '20';
    let signal;
    t.mock.method(globalThis, 'fetch', async (_input, init) => { signal = init.signal; return new Promise(() => {}); });
    const app = await buildApp({ worker: true });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: 'Bearer fixture' }, payload: { input: 'fixture', stream: true } });
      assert.equal(response.statusCode, 504);
      assert.equal(signal.aborted, true);
      assert.doesNotMatch(response.headers['content-type'], /event-stream/);
    } finally { await app.close(); if (previous === undefined) delete process.env.MIRROR_IDLE_TIMEOUT_MS; else process.env.MIRROR_IDLE_TIMEOUT_MS = previous; }
  });
  test('disconnect during pre-stream authentication aborts the upstream request', async t => {
    const { request } = await import('node:http');
    const started = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    t.mock.method(globalThis, 'fetch', async (_input, init) => {
      started.resolve();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted.resolve(); reject(init.signal.reason); }, { once: true }));
    });
    const app = await buildApp({ worker: true });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const req = request(`${address}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' } });
      req.on('error', () => {});
      req.end(JSON.stringify(routes[0][1]));
      await started.promise;
      req.destroy();
      await aborted.promise;
    } finally { await app.close(); }
  });

  test('external document entry shows a public shell and deep-link content still verifies the owner', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      calls++;
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/backend-api/me') return Response.json({ object: 'user', id: new Headers(init.headers).get('authorization') === 'Bearer owner' ? 'owner' : 'other' });
      return new Response('private thread document', { headers: { 'content-type': 'text/html' } });
    });
    const app = await buildApp({ worker: true, ownerUserId: 'owner' });
    const navigation = { accept: 'text/html', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    try {
      for (const url of ['/', '/c/fixture-thread?returnTo=https%3A%2F%2Fevil.example', '/c/fixture-thread/', '/g/g-fixture/c/fixture-thread', '/g/g-p-fixture/project']) {
        const before = calls;
        const shell = await app.inject({ url, headers: navigation });
        assert.equal(shell.statusCode, 200);
        assert.match(shell.body, /<form id="connect">/);
        assert.doesNotMatch(shell.body, /private thread document/);
        assert.equal(shell.headers.location, undefined);
        assert.equal(calls, before);
        for (const [token, expected] of [['', 401], ['other', 403], ['owner', 200]]) {
          const response = await app.inject({ url, headers: { accept: 'text/html', 'x-mirror-document': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
          assert.equal(response.statusCode, expected);
          assert.equal(response.body.includes('private thread document'), token === 'owner');
          assert.equal(response.headers.location, undefined);
        }
      }
      const denied = await app.inject({ method: 'POST', url: '/api/conversations', payload: {}, headers: { ...navigation, origin: 'https://external.example', authorization: 'Bearer owner' } });
      assert.equal(denied.statusCode, 403, 'cross-site mutation remains blocked even with the owner token');
      for (const url of ['/api/conversations', '/backend-api/conversation/fixture', '/v1/models']) {
        assert.equal((await app.inject({ url, headers: navigation })).statusCode, 401);
      }
    } finally { await app.close(); }
  });

  test('external navigation cannot create a Node control cookie', async t => {
    t.mock.method(globalThis, 'fetch', async () => assert.fail('cross-site Node entry must not reach upstream'));
    const app = await buildApp();
    try {
      const response = await app.inject({ url: '/c/fixture-thread', headers: { accept: 'text/html', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['set-cookie'], undefined);
    } finally { await app.close(); }
  });

});
