import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'mirror-worker-assets-'));
process.env.MIRROR_DATA_DIR = dir;
const { buildApp } = await import('../dist/index.js');
test.describe('server / Worker assets', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  test('reports unavailable assets and serves public API docs', async () => {
    const app = await buildApp({ worker: true });
    try {
      for (const url of ['/mirror/playground', '/mirror/assets/missing.js', '/assets/missing.js', '/favicon.ico']) {
        const response = await app.inject({ url, headers: url === '/mirror/playground' ? { accept: 'text/html', 'x-mirror-document': '1' } : {} });
        assert.equal(response.statusCode, 503, `${url}: ${response.body}`);
      }
      const docs = await app.inject({ url: '/mirror/api-docs', headers: { accept: 'text/html', 'x-mirror-document': '1' } });
      assert.equal(docs.statusCode, 200);
      assert.match(docs.body, /swagger-ui/);
    } finally { await app.close(); }
  });
  test('serves asset bytes and forwards a failed playground fetch', async () => {
    let failPlayground = false;
    const assets = { fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/index.html' && failPlayground) return new Response('fixture unavailable', { status: 503 });
      return new Response(`asset:${url.pathname}`, { headers: { 'content-type': 'text/plain' } });
    } };
    const app = await buildApp({ worker: true, assets });
    try {
      const page = () => app.inject({ url: '/mirror/playground', headers: { accept: 'text/html', 'x-mirror-document': '1' } });
      assert.equal((await page()).body, 'asset:/index.html');
      failPlayground = true;
      assert.equal((await page()).statusCode, 503);
      for (const [url, expected] of [['/mirror/assets/app.js', '/assets/app.js'], ['/assets/app.js', '/assets/app.js'], ['/favicon.ico', '/favicon.ico']]) {
        const response = await app.inject({ url });
        assert.equal(response.statusCode, 200);
        assert.equal(response.body, `asset:${expected}`);
      }
    } finally { await app.close(); }
  });
  test('falls back to the upstream for an asset missing from the bundle', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('upstream asset', { headers: { 'content-type': 'text/plain' } }));
    const app = await buildApp({ worker: true, assets: { fetch: async () => new Response('missing', { status: 404 }) } });
    try {
      const response = await app.inject({ url: '/assets/upstream.js' });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body, 'upstream asset');
    } finally { await app.close(); }
  });
});
