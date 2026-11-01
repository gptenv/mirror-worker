import { test, expect } from '@playwright/test';
import { BROWSER_BOOTSTRAP } from '../../apps/server/src/browser-bootstrap';

test.describe('browser / session bootstrap', () => {
  for (const mode of ['transient', 'verified-refresh', 'wrong-owner']) test(`${mode} preserves the credential boundary`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mirror_access_token', 'fixture-old-access');
      localStorage.setItem('mirror_session_token', 'fixture-old-session');
    });
    let calls = 0;
    await page.route('**/mirror/playground', async route => {
      if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: BROWSER_BOOTSTRAP });
      calls++;
      expect(route.request().headers()['authorization']).toBe('Bearer fixture-old-access');
      return route.fulfill({ status: mode === 'wrong-owner' ? 403 : mode === 'transient' ? 403 : 503,
        headers: { 'content-type': 'text/plain', 'x-mirror-access-token': 'fixture-fresh-access', 'x-mirror-session-token': 'fixture-fresh-session',
          ...(mode === 'verified-refresh' ? { 'x-mirror-auth-status': 'owner_verified' } : mode === 'wrong-owner' ? { 'x-mirror-auth-status': 'owner_mismatch' } : {}) },
        body: '<script>fixture-untrusted-error</script>',
      });
    });
    await page.goto('/mirror/playground');
    await expect(page.locator('#status')).toContainText(mode === 'wrong-owner' ? 'not the allowed owner' : 'could not connect');
    expect(await page.evaluate(() => [localStorage.getItem('mirror_access_token'), localStorage.getItem('mirror_session_token')])).toEqual(
      mode === 'wrong-owner' ? [null, null] : mode === 'verified-refresh' ? ['fixture-fresh-access', 'fixture-fresh-session'] : ['fixture-old-access', 'fixture-old-session']);
    expect(calls).toBe(1);
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    await expect(page.locator('body')).not.toContainText('fixture-untrusted-error');
  });
});
