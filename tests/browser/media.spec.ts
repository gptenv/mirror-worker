import { test, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

test.describe('browser / Spaces native media through workerd', () => {
  test.use({ ignoreHTTPSErrors: true });
  let worker: ChildProcess;
  let base: string;
  let external: Server;
  let externalHeaders: IncomingHttpHeaders[] = [];
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    external = createServer((request, response) => {
      if (request.method !== 'OPTIONS') externalHeaders.push(request.headers);
      response.writeHead(200, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'x-mirror-access-token,x-mirror-session-token', 'x-mirror-access-token': 'hostile', 'x-mirror-session-token': 'hostile' });
      response.end('external fixture');
    });
    await new Promise<void>(resolve => external.listen(0, resolve));
    const externalOrigin = `http://localhost:${(external.address() as AddressInfo).port}`;
    worker = fork(path.resolve('tests/browser/fixtures/navigation-worker.mjs'), { env: { ...process.env, MIRROR_TEST_REDIRECT_ORIGIN: externalOrigin }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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
    await new Promise<void>((resolve, reject) => external?.close(error => error ? reject(error) : resolve()));
  });
  test('wrapped fetch and XHR never send Mirror credentials across a third-party redirect', async ({ page }) => {
    externalHeaders = [];
    await page.goto(base + '/space/files');
    await page.locator('#credential').fill('fixture-owner-token'); await page.locator('#submit').click();
    await expect(page.locator('#file-menu')).toBeVisible();
    await page.evaluate(() => localStorage.setItem('mirror_session_token', 'fixture-owner-session'));
    const result = await page.evaluate(async () => {
      const url = '/api/library/files/libfile_fixture/redirect';
      let fetchRejected = false;
      try { await fetch(url); } catch { fetchRejected = true; }
      await new Promise<void>((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error(`XHR status ${xhr.status}`)); xhr.onerror = () => reject(new Error('Redirected XHR failed')); xhr.send(); });
      return { fetchRejected, access: localStorage.getItem('mirror_access_token'), session: localStorage.getItem('mirror_session_token') };
    });
    expect(result).toEqual({ fetchRejected: true, access: 'fixture-owner-token', session: 'fixture-owner-session' });
    expect(externalHeaders).toHaveLength(1);
    expect(externalHeaders[0].authorization).toBeUndefined();
    expect(externalHeaders[0]['x-mirror-session-token']).toBeUndefined();
    expect(externalHeaders[0].cookie).toBeUndefined();
    externalHeaders = [];
    await page.evaluate(() => new Promise<void>(resolve => {
      const image = new Image(); image.onload = image.onerror = () => resolve();
      image.src = '/api/library/files/libfile_fixture/redirect?native=1'; document.body.append(image);
    }));
    expect(externalHeaders).toHaveLength(1);
    expect(externalHeaders[0].authorization).toBeUndefined(); expect(externalHeaders[0]['x-mirror-session-token']).toBeUndefined(); expect(externalHeaders[0].cookie).toBeUndefined();
  });
  test('XHR refreshes an expired access token using the stored session without a custom credential header', async ({ page }) => {
    await page.goto(base + '/space/files');
    await page.locator('#credential').fill('fixture-owner-token'); await page.locator('#submit').click();
    await expect(page.locator('#file-menu')).toBeVisible();
    const result = await page.evaluate(async () => {
      localStorage.setItem('mirror_access_token', 'expired-access');
      localStorage.setItem('mirror_session_token', 'fixture-owner-session');
      const status = await new Promise<number>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open('GET', '/backend-api/fixture');
        xhr.onerror = () => reject(new Error('XHR failed')); xhr.send();
        xhr.addEventListener('loadend', () => resolve(xhr.status), { once: true });
      });
      return { status, access: localStorage.getItem('mirror_access_token'), session: localStorage.getItem('mirror_session_token') };
    });
    expect(result).toEqual({ status: 200, access: 'fixture-owner-token', session: 'fixture-owner-session' });
  });
  test('initial owner login loads Spaces file-list thumbnail and full image without a token refresh', async ({ page }) => {
    await page.goto(base + '/space/files');
    const preview = page.waitForResponse(response => response.url().endsWith('/api/library/files/libfile_fixture/thumbnail'));
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    expect((await preview).status()).toBe(200);
    for (const selector of ['#space-preview', '#space-full', '#estuary-preview']) {
      await expect.poll(() => page.locator(selector).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    }
    await page.reload();
    await expect.poll(() => page.locator('#space-preview').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  });
  test('Spaces file-list Download action returns the actual bytes and filename with existing browser credentials', async ({ page }) => {
    await page.goto(base + '/space/files');
    await page.locator('#credential').fill('fixture-owner-token');
    await page.locator('#submit').click();
    await page.locator('#file-menu').click();
    const pending = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe('Spaces fixture.txt');
    expect(await readFile((await download.path())!, 'utf8')).toBe('Spaces fixture file bytes\n');
  });
  test('native refresh updates cookies before image bytes, and later reads adopt each rotated session', async ({ page }) => {
    await page.goto(base + '/space/files');
    await page.locator('#credential').fill('fixture-owner-token'); await page.locator('#submit').click();
    await expect(page.locator('#file-menu')).toBeVisible();
    for (let index = 1; index <= 2; index++) {
      await page.evaluate(i => {
        localStorage.setItem('mirror_access_token', 'expired-access');
        localStorage.setItem('mirror_session_token', `fixture-rotating-session-${i}`);
        (window as any).__mirrorCredentials.publish();
      }, index);
      const response = page.waitForResponse(value => value.url().endsWith('/content?native=' + index));
      await page.evaluate(i => new Promise<void>((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(); image.onerror = () => reject(new Error('Native image failed'));
        image.src = `/api/library/files/libfile_fixture/content?native=${i}`; document.body.append(image);
      }), index);
      expect((await response).status()).toBe(200);
      expect(await page.evaluate(() => (window as any).__mirrorCredentials.sync())).toEqual([`fixture-owner-token-${index}`, `fixture-rotating-session-${index + 1}`]);
      const next = await page.context().request.get(base + '/api/library/files/libfile_fixture/content'); expect(next.status()).toBe(200);
    }
  });
  test('native cookies cover HEAD, ranges, same-origin redirects and direct image tabs, while writes and cross-site reads remain denied', async ({ page, request }) => {
    expect((await request.get(base + '/api/library/files/libfile_fixture/content')).status()).toBe(401);
    await page.goto(base + '/space/files'); await page.locator('#credential').fill('fixture-owner-token'); await page.locator('#submit').click();
    await expect(page.locator('#file-menu')).toBeVisible();
    const native = page.context().request;
    const head = await native.head(base + '/api/library/files/libfile_fixture/download'); expect(head.status()).toBe(200); expect(await head.body()).toHaveLength(0);
    expect(head.headers()['content-type']).toBe('text/plain'); expect(head.headers()['content-disposition']).toBe('attachment; filename="Spaces fixture.txt"');
    const range = await native.get(base + '/api/library/files/libfile_fixture/download', { headers: { range: 'bytes=0-5' } });
    expect(range.status()).toBe(206); expect(await range.text()).toBe('Spaces'); expect(range.headers()['content-range']).toBe('bytes 0-5/26');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await native.fetch(base + '/api/conversations', { method })).status()).toBe(401);
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://outside.example' }]) expect((await native.get(base + '/api/library/files/libfile_fixture/content', { headers })).status()).toBe(401);
    const popup = await page.context().newPage(); await popup.goto(base + '/api/library/files/libfile_fixture/redirect-local'); await expect(popup.locator('img')).toBeVisible(); await popup.close();
    await page.locator('#file-menu').click(); await page.getByRole('menuitem', { name: 'Download', exact: true }).evaluate(anchor => (anchor as HTMLAnchorElement).href = '/api/library/files/libfile_fixture/download-local');
    const pending = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
    const download = await pending; expect(await download.failure()).toBeNull(); expect(download.suggestedFilename()).toBe('Spaces fixture.txt');
    expect(await readFile((await download.path())!, 'utf8')).toBe('Spaces fixture file bytes\n');
  });
  test('wrong-owner and rejected native credentials cannot replace the owner or survive logout', async ({ page }) => {
    await page.goto(base + '/space/files'); await page.locator('#credential').fill('fixture-owner-token'); await page.locator('#submit').click(); await expect(page.locator('#file-menu')).toBeVisible();
    const native = page.context().request;
    expect((await native.get(base + '/api/library/files/libfile_fixture/content', { headers: { authorization: 'Bearer fixture-other-token' } })).status()).toBe(403);
    expect((await native.get(base + '/api/library/files/libfile_fixture/content')).status()).toBe(200);
    for (const [session, status] of [['fixture-wrong-session', 403], ['invalid-session', 401]] as const) {
      await page.evaluate(token => { localStorage.setItem('mirror_access_token', 'expired'); localStorage.setItem('mirror_session_token', token); (window as any).__mirrorCredentials.publish(); }, session);
      const denied = await native.get(base + '/api/library/files/libfile_fixture/content'); expect(denied.status()).toBe(status);
      expect(denied.headers()['x-mirror-access-token']).toBeUndefined(); expect(denied.headers()['x-mirror-session-token']).toBeUndefined();
      expect(await page.evaluate(() => (window as any).__mirrorCredentials.sync())).toEqual(['', '']);
    }
    await page.evaluate(() => { document.cookie = 'mirror_asset_session=legacy; Path=/api/asset-content; Secure'; (window as any).__mirrorCredentials.clear(); });
    expect((await page.context().cookies()).filter(cookie => cookie.name.startsWith('__Host-mirror_read') || cookie.name === 'mirror_asset_session')).toEqual([]);
    expect((await native.get(base + '/api/library/files/libfile_fixture/content')).status()).toBe(401);
  });
  test('packaged playground JavaScript loads through the production Worker with restored browser credentials', async ({ page }) => {
    await page.goto(base + '/mirror/playground'); await page.locator('#credential').fill('fixture-owner-token'); await page.locator('#submit').click();
    await page.getByRole('button', { name: '◇ Responses' }).click();
    await expect(page.getByRole('heading', { name: 'Responses', exact: true })).toBeVisible();
    await page.getByLabel('Bearer credential', { exact: true }).fill('');
    expect((await page.context().cookies()).filter(cookie => cookie.name.startsWith('__Host-mirror_read') || cookie.name === 'mirror_asset_session')).toEqual([]);
    expect((await page.context().request.get(base + '/api/library/files/libfile_fixture/content')).status()).toBe(401);
  });
});
