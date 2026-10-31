import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-owner-boundary-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
const store = await import('../dist/store.js');
const { runWithRequestSessionToken } = await import('../dist/auth.js');
const { ChatGptBackendClient } = await import('@mirror/protocol');

test.describe('server / Worker owner boundary', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  test.afterEach(() => test.mock.restoreAll());

  function seed() {
    store.saveVerifiedSession('owner-account', 'fixture-device');
    const conversation = store.createConversation({ model: 'auto', accountId: 'owner-account' });
    store.addMessage({ conversationId: conversation.id, upstreamNodeId: 'cached-node', role: 'assistant',
      content: 'Private owner transcript', status: 'complete', events: [] });
    return conversation.id;
  }

  function identityFetch() {
    test.mock.method(globalThis, 'fetch', async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/backend-api/me', 'cached operations must not read upstream history');
      const owner = new Headers(init.headers).get('authorization') === 'Bearer owner-token';
      return Response.json({ account: { account_user_id: owner ? 'owner-account' : 'other-account' } });
    });
  }

  test('another valid account cannot read, export, change or delete cached owner data', async () => {
    const id = seed();
    identityFetch();
    const app = await buildApp({ worker: true, ownerAccountId: 'owner-account' });
    try {
      for (const request of [
        { method: 'GET', url: '/api/conversations?sync=false' },
        { method: 'GET', url: `/api/conversations/${id}` },
        { method: 'GET', url: `/api/conversations/${id}/export?format=json` },
        { method: 'GET', url: `/api/conversations/${id}/export?format=markdown` },
        { method: 'GET', url: '/api/diagnostics' },
        { method: 'PATCH', url: `/api/conversations/${id}`, payload: { model: 'changed' } },
        { method: 'DELETE', url: `/api/conversations/${id}` },
        { method: 'POST', url: '/api/session' },
        { method: 'DELETE', url: '/api/session' },
      ]) {
        const response = await app.inject({ ...request, headers: { authorization: 'Bearer other-token' } });
        assert.equal(response.statusCode, 403, `${request.method} ${request.url}: ${response.body}`);
        assert.ok(!response.body.includes('Private owner transcript'));
      }
      assert.equal(store.getSession().accountId, 'owner-account');
      assert.equal(store.getConversation(id).model, 'auto');
      for (const url of [`/api/conversations/${id}`, `/api/conversations/${id}/export?format=json`, `/api/conversations/${id}/export?format=markdown`]) {
        const response = await app.inject({ url, headers: { authorization: 'Bearer owner-token' } });
        assert.equal(response.statusCode, 200, response.body);
        assert.match(response.body, /Private owner transcript/);
      }
      const deleted = await app.inject({ method: 'DELETE', url: `/api/conversations/${id}`, headers: { authorization: 'Bearer owner-token' } });
      assert.equal(deleted.statusCode, 200);
      assert.equal(store.getConversation(id), null);
    } finally { await app.close(); }
  });

  test('asset ticket is not authentication and asset cookie cannot authorize other routes', async () => {
    const id = seed();
    identityFetch();
    const ticket = store.sealAssetTicket({ pointer: 'file-service://fixture', conversationId: null, messageId: null, fileName: 'fixture.png' });
    let downloads = 0;
    test.mock.method(ChatGptBackendClient.prototype, 'resolveAssetDownloadMetadata', async () => ({ url: 'https://files.oaiusercontent.com/fixture', fileName: 'fixture.png' }));
    test.mock.method(ChatGptBackendClient.prototype, 'fetchAssetContent', async () => {
      downloads++;
      return new Response('fixture-image', { headers: { 'content-type': 'image/png' } });
    });
    const app = await buildApp({ worker: true, ownerAccountId: 'owner-account' });
    try {
      const url = `/api/asset-content?ticket=${encodeURIComponent(ticket)}`;
      for (const method of ['GET', 'HEAD']) {
        assert.equal((await app.inject({ method, url })).statusCode, 401);
        assert.equal((await app.inject({ method, url, headers: { cookie: 'mirror_asset_session=other-token' } })).statusCode, 403);
      }
      assert.equal(downloads, 0);
      const allowed = await app.inject({ url, headers: { cookie: 'mirror_asset_session=owner-token' } });
      assert.equal(allowed.statusCode, 200, allowed.body);
      assert.equal(downloads, 1);
      assert.equal(allowed.headers['cache-control'], 'no-store');
      assert.match(allowed.headers['content-security-policy'], /sandbox/);
      for (const protectedUrl of [`/api/conversations/${id}`, `/api/conversations/${id}/export?format=json`, '/api/diagnostics']) {
        assert.equal((await app.inject({ url: protectedUrl, headers: { cookie: 'mirror_asset_session=owner-token' } })).statusCode, 401);
      }
    } finally { await app.close(); }
  });

  test('overlapping Worker auth scopes cannot borrow owner identity while /me is pending', async () => {
    const id = seed();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    test.mock.method(globalThis, 'fetch', async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/backend-api/me');
      const headers = new Headers(init.headers);
      const owner = headers.get('authorization') === 'Bearer owner-token';
      if (owner) { started.resolve(); await release.promise; }
      assert.equal(headers.get('cookie'), `__Secure-next-auth.session-token=${owner ? 'owner-session' : 'other-session'}`);
      return Response.json({ account: { account_user_id: owner ? 'owner-account' : 'other-account' } });
    });
    const app = await buildApp({ worker: true, ownerAccountId: 'owner-account' });
    const request = (token, session) => runWithRequestSessionToken(token, () => app.inject({
      url: `/api/conversations/${id}`, headers: { authorization: `Bearer ${token}`, 'x-mirror-session-token': session },
    }), session, []);
    let owner;
    try {
      owner = request('owner-token', 'owner-session');
      await started.promise;
      const other = await request('other-token', 'other-session');
      assert.equal(other.statusCode, 403);
      assert.ok(!other.body.includes('Private owner transcript'));
      assert.equal(other.headers['x-mirror-access-token'], undefined);
      release.resolve();
      const allowed = await owner;
      assert.equal(allowed.statusCode, 200, allowed.body);
      assert.match(allowed.body, /Private owner transcript/);
    } finally { release.resolve(); await owner; await app.close(); }
  });

  test('local credential verification preserves exchange errors without revealing supplied credentials', async () => {
    seed();
    const body = '{"error":{"message":"upstream exchange temporarily unavailable","detail":"preserve this"}}';
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', async input => new URL(String(input)).pathname === '/api/auth/session'
      ? new Response(body, { status: 503, headers: { 'content-type': 'application/json' } })
      : new Response('expired', { status: 401 }));
    try {
      const response = await app.inject({ url: '/api/settings/hotkeys', headers: {
        authorization: 'Bearer fixture-expired-access', 'x-mirror-session-token': 'fixture-long-session',
      } });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error.message, body);
      assert.deepEqual(response.json().error.token_lengths.received, { sessionToken: 20, accessToken: 22 });
      assert.ok(!response.body.includes('fixture-expired-access'));
      assert.ok(!response.body.includes('fixture-long-session'));
      assert.equal(response.headers['x-mirror-access-token'], undefined);
    } finally { await app.close(); }
  });

  test('local credential verification fails closed on a transport error', async () => {
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic transport unavailable'); });
    try {
      const response = await app.inject({ url: '/api/settings/hotkeys', headers: { authorization: 'Bearer fixture-access' } });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.message, 'synthetic transport unavailable');
    } finally { await app.close(); }
  });

  for (const mode of ['rotated-secure', 'cookie-fallback', 'bearer-fallback']) test(`asset token refresh updates only the download cookie (${mode})`, async () => {
    seed();
    const ticket = store.sealAssetTicket({ pointer: 'file-service://fixture', conversationId: null, messageId: null, fileName: 'fixture.png' });
    const freshAccess = `fresh-${mode}`;
    const initial = `expired-${mode}`;
    test.mock.method(globalThis, 'fetch', async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/auth/session') return Response.json({ accessToken: freshAccess }, {
        headers: mode === 'rotated-secure' ? { 'set-cookie': '__Secure-next-auth.session-token=rotated-session; Path=/' } : {},
      });
      assert.equal(pathname, '/backend-api/me');
      if (new Headers(init.headers).get('authorization') !== `Bearer ${freshAccess}`) return new Response('expired', { status: 401 });
      return Response.json({ account: { account_user_id: 'owner-account' } });
    });
    test.mock.method(ChatGptBackendClient.prototype, 'resolveAssetDownloadMetadata', async () => ({ url: 'https://files.oaiusercontent.com/fixture', fileName: 'fixture.png' }));
    test.mock.method(ChatGptBackendClient.prototype, 'fetchAssetContent', async () => new Response('fixture-image', { headers: { 'content-type': 'image/png' } }));
    const app = await buildApp({ worker: true, ownerAccountId: 'owner-account' });
    try {
      const headers = mode === 'bearer-fallback' ? { authorization: `Bearer ${initial}` } : { cookie: `mirror_asset_session=${initial}` };
      if (mode === 'rotated-secure') headers['x-forwarded-proto'] = 'https';
      const response = await app.inject({ url: `/api/asset-content?ticket=${encodeURIComponent(ticket)}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['x-mirror-access-token'], freshAccess);
      assert.equal(response.headers['x-mirror-session-token'], mode === 'rotated-secure' ? 'rotated-session' : undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['set-cookie'], `mirror_asset_session=${mode === 'rotated-secure' ? 'rotated-session' : initial}; Path=/api/asset-content; SameSite=Strict${mode === 'rotated-secure' ? '; Secure' : ''}`);
    } finally { await app.close(); }
  });
});
