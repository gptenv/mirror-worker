import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test.describe('server / session-revision', () => {
  test('concurrent request credentials remain isolated when account metadata changes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mirror-session-revision-'));
    process.env.MIRROR_DATA_DIR = dir;
    const store = await import('../dist/store.js');
    const auth = await import('../dist/auth.js');
    const gate = Promise.withResolvers();
    try {
      store.saveVerifiedSession('old-account', 'device');
      const pending = auth.runWithRequestSessionToken('old-access', async () => {
        const creds = await auth.getValidCredentials();
        await gate.promise;
        return creds.accessToken;
      });
      store.saveVerifiedSession('new-account', 'device');
      const next = await auth.runWithRequestSessionToken('new-access', () => auth.getValidCredentials());
      gate.resolve();
      assert.equal(await pending, 'old-access');
      assert.equal(next.accessToken, 'new-access');
      assert.equal(store.getSession().accountId, 'new-account');
      assert.equal(store.getSession().sessionToken, undefined);
      assert.equal(store.getSession().cachedAccessToken, undefined);
    } finally { gate.resolve(); rmSync(dir, { recursive: true, force: true }); }
  });
});
