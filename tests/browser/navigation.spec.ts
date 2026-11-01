import { test, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';

test.describe('browser / protected navigation through workerd', () => {
  test.use({ ignoreHTTPSErrors: true }); // workerd's local test certificate
  let worker: ChildProcess;
  let base: string;
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    worker = fork(path.resolve('tests/browser/fixtures/navigation-worker.mjs'), { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let errors = '';
    worker.stderr!.on('data', chunk => { errors += chunk; });
    base = await new Promise<string>((resolve, reject) => {
      worker.once('message', (message: { url: string }) => resolve(message.url.replace(/\/$/, '')));
      worker.once('exit', code => reject(new Error(`Fixture exited ${code}: ${errors}`)));
      worker.once('error', reject);
    });
  });
  test.afterAll(async () => {
    if (worker?.exitCode === null) await new Promise<void>(resolve => { worker.once('exit', () => resolve()); worker.kill(); });
  });
  const paths = ['/space/', '/space/files', '/space/d/external-gdrive%3Aaccount%3Afixture%3Aroot?view=files#folder', '/c/fixture-thread?view=thread#message', '/g/g-p-fixture/c/fixture-thread', '/gpts', '/library/', '/images?view=all#gallery', '/search', '/future-ui/nested/document', '/g/g-fixture/encoded%20slug'];
  test('saved browser credentials restore direct entry, reload and back on arbitrary frontend routes', async ({ page }) => {
    await page.goto(base + '/');
    await page.evaluate(() => localStorage.setItem('mirror_access_token', 'fixture-owner-token'));
    for (const target of paths) {
      await page.goto(base + target);
      await expect(page.locator('#owner-document'), target).toBeVisible();
      await expect(page.locator('#document-url')).toHaveText(target);
      await expect(page).toHaveURL(base + target);
      await expect(page.locator('#credential')).toHaveCount(0);
    }
    await page.reload();
    await expect(page.locator('#owner-document')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#document-url')).toHaveText(paths.at(-2)!);
  });
  test('internal SPA links and fresh navigation reach the same authenticated route', async ({ page }) => {
    await page.goto(base + '/');
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    await expect(page.locator('#owner-document')).toBeVisible();
    await page.locator('#internal').click();
    await expect(page).toHaveURL(base + '/library');
    await page.reload();
    await expect(page.locator('#owner-document')).toBeVisible();
    await expect(page.locator('#document-url')).toHaveText('/library');
  });
  test('external links expose only the shell, then retain query/fragment after owner authentication', async ({ page }) => {
    const target = '/gpts?returnTo=https%3A%2F%2Funsafe.example%2F#browse';
    await page.route('https://outside.example/**', route => route.fulfill({ contentType: 'text/html', body: `<a href="${base + target}">Open app</a>` }));
    await page.goto('https://outside.example/');
    const navigation = page.waitForRequest(request => request.url().startsWith(base) && request.isNavigationRequest());
    await page.getByRole('link', { name: 'Open app' }).click();
    // Playwright's intercepted outside origin does not expose Fetch Metadata
    // here; raw-HTTP workerd tests separately cover explicit cross-site headers.
    expect((await navigation).isNavigationRequest()).toBe(true);
    await expect(page.locator('#credential')).toBeVisible();
    await page.locator('#credential').fill('fixture-other-token');
    await page.locator('#submit').click();
    await expect(page.locator('#status')).toContainText('not the allowed owner');
    expect(await page.evaluate(() => localStorage.getItem('mirror_access_token'))).toBeNull();
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    await expect(page.locator('#document-url')).toHaveText(target);
    await expect(page).toHaveURL(base + target);
  });
  test('empty, expired and temporarily unavailable credentials retain a usable direct-entry form', async ({ page }) => {
    await page.goto(base + '/library');
    await expect(page.locator('#credential')).toBeVisible();
    for (const [token, message] of [['fixture-expired', 'Credential not accepted'], ['fixture-transient', 'Mirror could not connect']]) {
      await page.evaluate(value => localStorage.setItem('mirror_access_token', value), token);
      await page.reload();
      await expect(page.locator('#status')).toContainText(message);
      expect(await page.evaluate(() => localStorage.getItem('mirror_access_token'))).toBe(token === 'fixture-expired' ? null : token);
      await expect(page).toHaveURL(base + '/library');
    }
  });
  test('OpenAPI navigation restores credentials and renders JSON/YAML as text; API requests stay protected', async ({ page, request }) => {
    await page.goto(base + '/');
    await page.evaluate(() => localStorage.setItem('mirror_access_token', 'fixture-owner-token'));
    for (const format of ['json', 'yaml']) {
      await page.goto(base + '/mirror/openapi?format=' + format + '#spec');
      await expect(page.locator('pre')).toContainText('openapi');
      await expect(page).toHaveURL(base + '/mirror/openapi?format=' + format + '#spec');
    }
    for (const route of ['/mirror/openapi', '/api/conversations', '/backend-api/conversation/fixture']) {
      const denied = await request.get(base + route, { headers: { accept: 'application/json' } });
      expect(denied.status()).toBe(401);
      expect(denied.headers()['content-type']).toContain('application/json');
    }
    const yaml = await request.get(base + '/mirror/openapi?format=yaml', { headers: { authorization: 'Bearer fixture-owner-token', accept: 'application/yaml' } });
    expect(yaml.status()).toBe(200);
    expect(yaml.headers()['content-type']).toContain('application/yaml');
  });
  test('Swagger uses the browser credential when fetching its protected OpenAPI document', async ({ page }) => {
    await page.route('https://unpkg.com/swagger-ui-dist@5.20.0/*', route => {
      const filename = new URL(route.request().url()).pathname.split('/').at(-1)!;
      if (!['swagger-ui-bundle.js', 'swagger-ui.css'].includes(filename)) return route.abort();
      return route.fulfill({ path: path.resolve('node_modules/@fastify/swagger-ui/static', filename) });
    });
    await page.goto(base + '/');
    await page.evaluate(() => localStorage.setItem('mirror_access_token', 'fixture-owner-token'));
    const spec = page.waitForResponse(response => response.url() === base + '/mirror/openapi');
    await page.goto(base + '/mirror/api-docs');
    const response = await spec;
    expect(response.status()).toBe(200);
    expect((await response.request().allHeaders()).authorization).toBe('Bearer fixture-owner-token');
    await expect(page.locator('#swagger-ui .info .title')).toContainText('Mirror');
    await expect(page.locator('#credential')).toHaveCount(0);
  });
  test('credential-bearing document fetch rejects an unsafe upstream redirect', async ({ page }) => {
    let unsafeRequests = 0;
    await page.route('https://unsafe.example/**', async route => { unsafeRequests++; await route.abort(); });
    await page.goto(base + '/unsafe-redirect');
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    await expect(page.locator('#status')).toContainText('Connection interrupted');
    await expect(page).toHaveURL(base + '/unsafe-redirect');
    expect(unsafeRequests).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('mirror_access_token'))).toBeNull();
  });
});
