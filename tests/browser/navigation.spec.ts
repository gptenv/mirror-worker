import { test, expect } from '@playwright/test';
import { BROWSER_BOOTSTRAP } from '../../apps/server/src/browser-bootstrap';
import { mayBootstrapBrowser } from '../../apps/server/src/security';

test.describe('browser / protected navigation', () => {
  let protectedRequests: string[];
  let redirectDocument: boolean;
  test.beforeEach(async ({ page }) => {
    protectedRequests = []; redirectDocument = false;
    await page.route('http://outside.example/**', route => route.fulfill({ contentType: 'text/html', body: '<a href="http://127.0.0.1:4173/c/fixture-thread?view=thread#message">Open thread</a>' }));
    await page.route('http://127.0.0.1:4173/**', async route => {
      const req = route.request();
      if (req.headers()['x-mirror-document'] === '1') protectedRequests.push(req.url());
      const url = new URL(req.url());
      const headers = await req.allHeaders();
      if (req.isNavigationRequest()) {
        const allowed = mayBootstrapBrowser(req.method(), url.pathname + url.search, headers, true);
        return route.fulfill({ status: allowed ? 200 : 401, contentType: 'text/html', body: allowed ? BROWSER_BOOTSTRAP : 'Access denied' });
      }
      if (headers.authorization !== 'Bearer fixture-owner-token') return route.fulfill({ status: 403, headers: { 'x-mirror-auth-status': 'owner_mismatch' }, body: 'wrong owner' });
      if (redirectDocument) return route.fulfill({ status: 302, headers: { location: 'https://unsafe.example/collect' } });
      return route.fulfill({ contentType: 'text/html', headers: { 'x-mirror-auth-status': 'owner_verified' }, body: '<!doctype html><html><body><main id="owner-document">Owner thread document</main></body></html>' });
    });
  });
  test('an external link reconnects at the thread URL and survives reload and browser back', async ({ page }) => {
    await page.goto('http://outside.example/');
    await page.getByRole('link', { name: 'Open thread' }).click();
    await expect(page.locator('#credential')).toBeVisible();
    expect(protectedRequests).toEqual([]);
    const target = 'http://127.0.0.1:4173/c/fixture-thread?view=thread#message';
    await expect(page).toHaveURL(target);
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    await expect(page.locator('#owner-document')).toBeVisible();
    await expect(page).toHaveURL(target);
    await page.reload();
    await expect(page.locator('#owner-document')).toBeVisible();
    await page.goto('/c/second-thread');
    await expect(page.locator('#owner-document')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#owner-document')).toBeVisible();
    await expect(page).toHaveURL(target);
    expect(protectedRequests.every(url => url.startsWith('http://127.0.0.1:4173/c/'))).toBe(true);
  });
  test('project deep links preserve query and fragment and ignore external return parameters', async ({ page }) => {
    const target = '/g/g-p-fixture/c/fixture-thread?returnTo=https%3A%2F%2Funsafe.example%2F#answer';
    await page.goto(target);
    await page.locator('#credential').fill('fixture-other-token');
    await page.locator('#submit').click();
    await expect(page.locator('#status')).toContainText('not the allowed owner');
    await expect(page.locator('#owner-document')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('mirror_access_token'))).toBeNull();
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    await expect(page.locator('#owner-document')).toBeVisible();
    await expect(page).toHaveURL('http://127.0.0.1:4173' + target);
    expect(protectedRequests).toHaveLength(2);
    expect(protectedRequests.every(url => url.includes('/g/g-p-fixture/c/fixture-thread?returnTo='))).toBe(true);
  });
  test('credential-bearing document fetch rejects an unsafe upstream redirect', async ({ page }) => {
    redirectDocument = true;
    let unsafeRequests = 0;
    await page.route('https://unsafe.example/**', async route => { unsafeRequests++; await route.abort(); });
    await page.goto('/c/fixture-thread');
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    await expect(page.locator('#status')).toContainText('Connection interrupted');
    await expect(page).toHaveURL('http://127.0.0.1:4173/c/fixture-thread');
    expect(unsafeRequests).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('mirror_access_token'))).toBeNull();
  });
});
