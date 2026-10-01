import './dom-setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mirrorFetch } from '../src/client-auth.js';

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
});
