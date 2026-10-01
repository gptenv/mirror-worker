import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGptBackendClient, runWithUpstreamFetch } from '@mirror/protocol';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-cookie-auth-'));
process.env.MIRROR_DATA_DIR = dir;
const { configuredApiKeys } = await import('../dist/security.js');
const { getValidCredentials, getRotatedRequestAccessToken, runWithRequestSessionToken } = await import('../dist/auth.js');
test.describe('server / upstream-cookie-auth', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  test('all supported settings select their first token in the existing preference order', async () => {
    for (const settings of [
      { MIRROR_API_KEY: 'primary-session', MIRROR_API_KEYS: 'secondary-session,third-session', OPENAI_API_KEY: 'last-session' },
      { MIRROR_API_KEYS: 'secondary-session,third-session', OPENAI_API_KEY: 'last-session' },
      { OPENAI_API_KEY: 'last-session' },
    ]) {
      const keys = configuredApiKeys(settings);
      await runWithRequestSessionToken(keys.at(-1), async () => {
        const credentials = await getValidCredentials();
        assert.equal(credentials.sessionToken, keys[0]);
        assert.equal(credentials.cookie, '__Secure-next-auth.session-token=' + keys[0]);
        assert.equal(await getRotatedRequestAccessToken(), undefined);
        await runWithUpstreamFetch(async (url, init) => {
          assert.equal(new Headers(init.headers).get('cookie'), credentials.cookie);
          return Response.json({ id: 'test-user' });
        }, () => new ChatGptBackendClient(credentials).fetchMe());
      }, undefined, keys);
    }
  });
  test('client-held session cookies remain complete and update on rotation', async () => {
    const session = 'session-' + 'x'.repeat(24000);
    await runWithRequestSessionToken('old-access', async () => {
      const credentials = await getValidCredentials();
      const cookies = [];
      await runWithUpstreamFetch(async (input, init) => {
        const headers = new Headers(init.headers); cookies.push(headers.get('cookie'));
        if (String(input).endsWith('/api/auth/session')) return Response.json({ accessToken: 'new-access' }, {
          headers: { 'set-cookie': '__Secure-next-auth.session-token=rotated-session; Path=/' },
        });
        if (headers.get('authorization') === 'Bearer old-access') return new Response('denied', { status: 401 });
        assert.equal(headers.get('authorization'), 'Bearer new-access');
        return Response.json({ id: 'test-user' });
      }, () => new ChatGptBackendClient(credentials).fetchMe());
      assert.deepEqual(cookies, ['__Secure-next-auth.session-token=' + session, '__Secure-next-auth.session-token=' + session, '__Secure-next-auth.session-token=rotated-session']);
      assert.equal(await getRotatedRequestAccessToken(), 'new-access');
      assert.equal(credentials.sessionToken, 'rotated-session');
    }, session, []);
  });
  test('an arbitrary bearer cannot select a configured account cookie', async () => {
    await runWithRequestSessionToken('client-access', async () => {
      const credentials = await getValidCredentials();
      assert.equal(credentials.accessToken, 'client-access');
      assert.equal(credentials.cookie, '__Secure-next-auth.session-token=client-session');
    }, 'client-session', ['configured-account-session']);
  });
});
