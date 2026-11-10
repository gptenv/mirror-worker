import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCredentials } from '@mirror/protocol';
import { nativeReadCredentials, applyNativeCredentialCookies } from '../dist/native-credentials.js';
import { runWithRequestSessionToken, getValidCredentials } from '../dist/auth.js';
function cookie(pair) { const values = []; createBrowserCredentials(undefined, { read: () => '', write: value => { if (!value.includes('Max-Age=0')) values.push(value.split(';')[0]); } }).writeCookie(pair); return values.join('; '); }
function request(headers = {}, method = 'GET') { return { method, protocol: 'https', headers: { host: 'mirror.example', cookie: cookie(['old', 'session']), ...headers } }; }
function reply(req, status, existing) { const headers = new Map([['x-mirror-auth-status', status], ['set-cookie', existing]]); return { request: req, getHeader: key => headers.get(key), header: (key, value) => headers.set(key, value), headers }; }
test.describe('server / native read credential boundaries', () => {
  test('cookies authenticate only enabled read requests with same-origin metadata and no explicit authorization', () => {
    assert.equal(nativeReadCredentials(request(), false), undefined);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(nativeReadCredentials(request({}, method), true), undefined);
    for (const headers of [{ authorization: 'Bearer explicit' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }, { cookie: '' }, { cookie: '__Host-mirror_read=rejected' }]) assert.equal(nativeReadCredentials(request(headers), true), undefined);
    for (const headers of [{}, { 'sec-fetch-site': 'same-origin', origin: 'https://mirror.example' }, { 'sec-fetch-site': 'none' }]) {
      assert.deepEqual(nativeReadCredentials(request(headers), true), ['old', 'session']);
      assert.deepEqual(nativeReadCredentials(request(headers, 'HEAD'), true), ['old', 'session']);
    }
    const noCookie = request(); delete noCookie.headers.cookie; assert.equal(nativeReadCredentials(noCookie, true), undefined);
  });
  test('only verified native reads receive rotations; rejection clears new and legacy cookies', async () => {
    await applyNativeCredentialCookies(reply(request(), 'owner_verified'));
    for (const status of [undefined, 'upstream_failure', 'owner_mismatch', 'credential_rejected']) {
      const req = request(); nativeReadCredentials(req, true); const res = reply(req, status);
      await applyNativeCredentialCookies(res);
      if (status === 'owner_mismatch' || status === 'credential_rejected') {
        assert.ok(res.headers.get('set-cookie').some(value => /^__Host-mirror_read\.[a-z0-9]+\.rejected\.[a-z0-9]+=1;/.test(value)));
        assert.ok(!res.headers.get('set-cookie').some(value => value.startsWith('__Host-mirror_read=')));
      } else assert.equal(res.headers.get('set-cookie'), undefined);
    }
    for (const [pair, access, session, existing] of [
      [['old', 'session'], 'fresh', 'rotated', 'unrelated=1'],
      [['old', 'session'], 'fresh', undefined, ['unrelated=1']],
      [['old', ''], 'fresh', undefined, undefined],
      [['fresh', ''], 'fresh', undefined, undefined],
      [['old', ''], undefined, 'rotated', undefined],
      [['old', 'session'], undefined, undefined, undefined],
    ]) await runWithRequestSessionToken('old', async () => {
      const req = request({ cookie: cookie(pair) }); nativeReadCredentials(req, true);
      const credentials = await getValidCredentials(); if (access) credentials.accessToken = access; if (session) credentials.rotatedSessionToken = session;
      const res = reply(req, 'owner_verified', existing); await applyNativeCredentialCookies(res);
      if (access || session) { assert.ok(Array.isArray(res.headers.get('set-cookie'))); assert.equal(res.headers.get('cache-control'), 'no-store'); }
      else assert.equal(res.headers.get('set-cookie'), undefined);
    });
    const missing = request(); nativeReadCredentials(missing, true); delete missing.headers.cookie;
    await applyNativeCredentialCookies(reply(missing, 'credential_rejected'));
  });
});
