import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test, { mock } from 'node:test';

const directory = mkdtempSync(path.join(tmpdir(), 'mirror-cookie-fallback-'));
process.env.MIRROR_DATA_DIR = directory;
const authUrl = new URL('../dist/auth.js', import.meta.url);
const realAuth = await import(authUrl.href);
const fixtureUrl = new URL('./helpers/asset-cookie-auth.mjs', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  return resolved.url === authUrl.href ? { ...resolved, url: fixtureUrl.href } : resolved;
} });
const authMock = mock.module(fixtureUrl.href, { exports: { ...realAuth, getRequestSessionToken: () => undefined } });
const { buildApp } = await import('../dist/index.js');

test.describe('server / asset cookie optional-accessor fallback', () => {
  test.after(() => { authMock.restore(); hooks.deregister(); rmSync(directory, { recursive: true, force: true }); });
  test('retains a usable download credential when the optional original-bearer accessor is unavailable', async t => {
    // This tests the response hook's defensive dependency contract, not a
    // normal auth state: real request scope retains its original bearer.
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/auth/session') return Response.json({ accessToken: 'fixture-refreshed' });
      assert.equal(pathname, '/backend-api/me');
      return new Headers(init.headers).get('authorization') === 'Bearer fixture-expired'
        ? new Response('expired', { status: 401 })
        : Response.json({ account: { account_user_id: 'fixture-owner' } });
    });
    const app = await buildApp({ worker: true, ownerAccountId: 'fixture-owner' });
    try {
      const response = await realAuth.runWithRequestSessionToken('fixture-expired', () => app.inject({
        url: '/api/asset-content',
        headers: { authorization: 'Bearer fixture-expired', 'x-forwarded-proto': 'https' },
      }), undefined, []);
      assert.equal(response.statusCode, 404, 'a missing ticket does not grant asset access');
      assert.equal(response.headers['x-mirror-access-token'], 'fixture-refreshed');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['set-cookie'], 'mirror_asset_session=fixture-refreshed; Path=/api/asset-content; SameSite=Strict; Secure');
    } finally { await app.close(); }
  });
});
