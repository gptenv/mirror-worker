import './dom-setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mirrorFetch, readStoredBearer, readStoredSessionToken, storeAccessToken, endpointOrigin, endpointHeaders, downloadAuthenticated } from '../src/client-auth.js';

test.describe('web / client-auth', () => {
  test.afterEach(() => { test.mock.restoreAll(); localStorage.clear(); });
  test('all local settings, history and utility endpoints send stored credentials', async () => {
    localStorage.setItem('mirror_access_token', 'stored-access');
    localStorage.setItem('mirror_session_token', 'stored-session');
    let count = 0;
    test.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer stored-access');
      assert.equal(headers.get('x-mirror-session-token'), 'stored-session');
      count++;
      return Response.json({ok:true});
    });
    for (const url of ['/api/settings/default-system-instructions', '/api/settings/hotkeys', '/api/conversations', '/api/conversations/search', '/api/diagnostics', '/api/convert/loaf/encode', '/v1/models']) {
      await mirrorFetch(url, {headers:{authorization:'Bearer application-header', 'x-mirror-session-token':'wrong-session'}});
    }
    assert.equal(count, 7);
  });
  test('session-only storage supplies both the bearer and fallback session header', async () => {
    localStorage.setItem('mirror_session_token','session-'+'x'.repeat(24000));
    test.mock.method(globalThis,'fetch',async(_input: RequestInfo | URL, init?: RequestInit)=>{
      const headers=new Headers(init?.headers);
      assert.equal(headers.get('authorization'),'Bearer '+localStorage.getItem('mirror_session_token'));
      assert.equal(headers.get('x-mirror-session-token'),localStorage.getItem('mirror_session_token'));
      return Response.json({ok:true});
    });
    await mirrorFetch('/api/settings/default-system-instructions');
  });
  test('the next request reads rotated tokens from storage', async () => {
    localStorage.setItem('mirror_access_token','old-access');
    localStorage.setItem('mirror_session_token','old-session');
    let count=0;
    test.mock.method(globalThis,'fetch',async(_input: RequestInfo | URL, init?: RequestInit)=>{
      const headers=new Headers(init?.headers);
      assert.equal(headers.get('authorization'), count ? 'Bearer fresh-access' : 'Bearer old-access');
      assert.equal(headers.get('x-mirror-session-token'),count ? 'fresh-session' : 'old-session');
      count++;
      return Response.json({}, {headers:{'x-mirror-access-token':'fresh-access','x-mirror-session-token':'fresh-session'}});
    });
    await mirrorFetch('/api/diagnostics');
    await mirrorFetch('/api/settings/default-system-instructions');
    assert.equal(count,2);
  });
  test('session rotation is saved even without an access-token response header', async () => {
    localStorage.setItem('mirror_access_token','access');
    localStorage.setItem('mirror_session_token','old-session');
    test.mock.method(globalThis,'fetch',async()=>Response.json({}, {headers:{'x-mirror-session-token':'rotated-session'}}));
    await mirrorFetch('/api/diagnostics');
    assert.equal(localStorage.getItem('mirror_session_token'),'rotated-session');
    assert.equal(localStorage.getItem('mirror_access_token'),'access');
  });
  test('Request inputs keep their method/body and non-auth headers', async () => {
    localStorage.setItem('mirror_access_token','access');
    const input=new Request(location.origin+'/api/settings/hotkeys',{method:'PUT',body:'{}',headers:{'content-type':'application/json'}});
    test.mock.method(globalThis,'fetch',async(request: RequestInfo | URL,init?: RequestInit)=>{
      assert.equal(request,input);assert.equal(input.method,'PUT');assert.equal(await input.text(),'{}');
      assert.equal(new Headers(init?.headers).get('content-type'),'application/json');
      assert.equal(new Headers(init?.headers).get('authorization'),'Bearer access');
      return Response.json({});
    });
    await mirrorFetch(input);
  });
  test('credentials are not attached to unrelated origins', async () => {
    localStorage.setItem('mirror_access_token','private-access');
    localStorage.setItem('mirror_session_token','private-session');
    test.mock.method(globalThis,'fetch',async(_input: RequestInfo | URL,init?: RequestInit)=>{
      assert.equal(new Headers(init?.headers).get('authorization'),null);
      assert.equal(new Headers(init?.headers).get('x-mirror-session-token'),null);
      return Response.json({});
    });
    await mirrorFetch('https://unrelated.example/file');
  });
  test('rotated access credentials preserve a prior session for fallback', async () => {
    storeAccessToken('new-access', 'old-session');
    assert.equal(readStoredBearer(), 'new-access');
    assert.equal(readStoredSessionToken(), 'old-session');
  });
  test('empty storage strips the session header and saves a rotated session', async () => {
    test.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('x-mirror-session-token'), null);
      return Response.json({}, { headers: { 'x-mirror-session-token': 'new-session' } });
    });
    await mirrorFetch('/api/health', { headers: { 'x-mirror-session-token': 'stale' } });
    assert.equal(readStoredSessionToken(), 'new-session');
  });
  test('a storage failure does not prevent a response from being returned', async () => {
    test.mock.method(Storage.prototype, 'getItem', () => { throw new Error('unavailable'); });
    test.mock.method(Storage.prototype, 'setItem', () => { throw new Error('unavailable'); });
    test.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }, { headers: { 'x-mirror-access-token': 'rotated' } }));
    assert.equal(readStoredBearer(), '');
    assert.equal(readStoredSessionToken(), '');
    assert.equal((await mirrorFetch('/api/health')).status, 200);
  });
  test('endpoint parsing and headers isolate external credentials', () => {
    localStorage.setItem('mirror_access_token', 'owner');
    localStorage.setItem('mirror_session_token', 'session');
    for (const value of ['not a url', 'javascript:alert(1)', 'https://user:pass@external.example']) assert.equal(endpointOrigin(value), null);
    assert.throws(() => endpointHeaders('invalid'), /valid HTTP/);
    assert.equal(endpointHeaders(location.origin).get('authorization'), 'Bearer owner');
    assert.equal(endpointHeaders(location.origin).get('x-mirror-session-token'), 'session');
    assert.equal(endpointHeaders('https://external.example', 'external').get('authorization'), 'Bearer external');
    assert.equal(endpointHeaders('https://external.example', 'external').get('x-mirror-session-token'), null);
    assert.equal(endpointHeaders('https://external.example').get('authorization'), null);
  });
  test('external Request credentials and hostile rotations cannot leak or replace owner tokens', async () => {
    localStorage.setItem('mirror_access_token', 'owner');
    localStorage.setItem('mirror_session_token', 'session');
    test.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      assert.equal(new Headers(init?.headers).get('x-mirror-session-token'), null);
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      return Response.json({}, { headers: { 'x-mirror-access-token': 'hostile', 'x-mirror-session-token': 'hostile-session' } });
    });
    await mirrorFetch(new Request('https://external.example', { headers: { authorization: 'bearer  owner ', 'x-mirror-session-token': 'session' } }));
    assert.equal(readStoredBearer(), 'owner');
    assert.equal(readStoredSessionToken(), 'session');
  });
  test('authenticated downloads fetch blobs and release temporary URLs', async () => {
    localStorage.setItem('mirror_access_token', 'owner');
    test.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer owner');
      assert.equal(init?.redirect, 'error');
      return new Response('archive');
    });
    let clicked = false;
    let revoked = '';
    test.mock.method(URL, 'createObjectURL', () => 'blob:archive');
    test.mock.method(URL, 'revokeObjectURL', value => { revoked = value; });
    test.mock.method(window.HTMLAnchorElement.prototype, 'click', function(this: HTMLAnchorElement) {
      clicked = true; assert.equal(this.download, 'archive.json'); assert.equal(this.href, 'blob:archive');
    });
    test.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { callback(); return 0; }) as typeof setTimeout);
    await downloadAuthenticated('/api/conversations/test/export', 'archive.json');
    assert.equal(clicked, true);
    assert.equal(revoked, 'blob:archive');
    assert.equal(document.querySelector('a[download]'), null);
    await assert.rejects(downloadAuthenticated('https://external.example', 'nope'), /this Mirror origin/);
    test.mock.method(globalThis, 'fetch', async () => new Response('denied', { status: 401 }));
    await assert.rejects(downloadAuthenticated('/api/diagnostics', 'nope'), /denied/);
  });

  test('HTTPS rotation without a session uses the access token for secure asset cookies', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')!;
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://worker.example') });
    try { storeAccessToken('access-only'); assert.equal(readStoredBearer(), 'access-only'); }
    finally { Object.defineProperty(globalThis, 'location', descriptor); }
  });

});
