import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCredentials } from '../dist/browser-credentials.js';

function fixture() {
  const items = new Map(), jar = new Map(), written = [];
  const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
  const cookies = { read: () => [...jar].map(([key, value]) => key + '=' + value).join('; '), write: value => {
    written.push(value); const [key, data] = value.split(';')[0].split(/=(.*)/s);
    if (value.includes('Max-Age=0')) jar.delete(key); else jar.set(key, data);
  } };
  return { items, jar, written, store: createBrowserCredentials(storage, cookies) };
}
test.describe('protocol / browser credential cookies', () => {
  test('large credentials round-trip as host-only secure session chunks without cross-generation mixing', () => {
    const f = fixture(); const pair = ['a'.repeat(8000), 'session;=☃'];
    f.store.writeCookie(pair); assert.deepEqual(f.store.readCookie(), pair);
    const active = f.written.filter(value => value.startsWith('__Host-mirror_read') && !value.includes('Max-Age=0'));
    assert.equal(active.length, 4);
    for (const value of active) { assert.ok(value.length < 4096); assert.match(value, /; Path=\/; Secure; SameSite=Strict$/); assert.doesNotMatch(value, /Domain|HttpOnly|Expires|Max-Age/); }
    f.store.writeCookie(['new', 'new-session']); assert.deepEqual(f.store.readCookie(), ['new', 'new-session']);
    assert.equal([...f.jar.keys()].length, 3);
    f.store.writeCookie(['a'.repeat(48001), '']); assert.equal(f.store.readCookie(), undefined);
    f.store.writeCookie(['', '']); assert.equal(f.store.readCookie(), undefined);
  });
  test('malformed, incomplete and oversized cookie descriptors never authenticate', () => {
    const f = fixture();
    for (const descriptor of ['', 'bad', 'x:17', 'x:0', 'x:1']) { f.jar.set('__Host-mirror_read', descriptor); assert.equal(f.store.readCookie(), undefined); }
    for (const body of ['%', 'invalid', 'null', '[1,2]', '["", ""]', '["one"]']) {
      f.jar.set('__Host-mirror_read.x.0', body); assert.equal(f.store.readCookie(), undefined);
    }
    f.jar.set('__Host-mirror_read.x.0', encodeURIComponent('["session", ""]')); assert.deepEqual(f.store.readCookie(), ['session', '']);
    f.store.clearCookie(true); assert.equal(f.store.readCookie(), 'rejected');
  });
  test('native rotation synchronizes storage, while explicit replacement and logout win over stale cookies', () => {
    const f = fixture(); assert.deepEqual(f.store.sync(), ['', '']); assert.deepEqual(f.store.sync(), ['', '']);
    f.items.set('mirror_access_token', 'old'); assert.deepEqual(f.store.sync(), ['old', '']);
    f.store.writeCookie(['fresh', 'rotated-session']); assert.deepEqual(f.store.sync(), ['fresh', 'rotated-session']);
    f.items.set('mirror_access_token', 'manual'); f.items.delete('mirror_session_token');
    assert.deepEqual(f.store.sync(), ['manual', '']); assert.deepEqual(f.store.readCookie(), ['manual', '']);
    f.jar.clear(); assert.deepEqual(f.store.sync(), ['manual', '']); assert.deepEqual(f.store.readCookie(), ['manual', '']);
    f.store.clearCookie(true); assert.deepEqual(f.store.sync(), ['', '']);
    f.items.set('mirror_access_token', 'saved'); f.store.publish(); assert.deepEqual(f.store.readCookie(), ['saved', '']);
    f.jar.set('mirror_asset_session', 'legacy'); f.store.clear(); assert.equal(f.items.get('mirror_access_token'), undefined); assert.equal(f.jar.size, 0);
    f.store.writeCookie(['late', 'late-session']); assert.deepEqual(f.store.sync(), ['', '']); assert.equal(f.jar.size, 0);
  });
});
