import assert from 'node:assert/strict';
import test from 'node:test';
globalThis.WebSocketPair = class {};
const { resolveImageAttachment } = await import('../dist/conversation-context.js');
const originalFetch = globalThis.fetch;
const client = { uploadFile: async input => ({ fileId: 'fixture', ...input }) };
const part = url => ({ type: 'image_url', image_url: { url } });

test.describe('server / Worker attachment DNS checks', () => {
  test.afterEach(() => { globalThis.fetch = originalFetch; });
  test.after(() => { delete globalThis.WebSocketPair; });
  test('Worker control cookies require a secure connection', async () => {
    const { controlCookie } = await import('../dist/security.js?worker-cookie');
    assert.match(controlCookie(), /; Secure$/);
  });
  test('uploads content only after both DNS answers are public', async () => {
    const seen = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input)); seen.push(url.hostname);
      if (url.hostname === 'cloudflare-dns.com') return Response.json({ Answer: [{ data: url.searchParams.get('type') === 'A' ? '8.8.8.8' : '2001:4860:4860::8888' }] });
      return new Response('fixture-image', { headers: { 'content-type': 'image/png' } });
    };
    const result = await resolveImageAttachment(client, part('https://public.example/image'), 0);
    assert.equal(result.fileId, 'fixture');
    assert.equal(seen.filter(host => host === 'cloudflare-dns.com').length, 2);
    assert.equal(seen.at(-1), 'public.example');
  });
  test('rejects private and missing DNS answers before fetching the asset', async () => {
    for (const answer of [[{ data: '127.0.0.1' }], []]) {
      globalThis.fetch = async input => { assert.equal(new URL(String(input)).hostname, 'cloudflare-dns.com'); return Response.json({ Answer: answer }); };
      await assert.rejects(resolveImageAttachment(client, part('https://public.example/image'), 0), /does not resolve exclusively to public addresses/);
    }
  });
  test('propagates a DNS service error and handles a public literal IP', async () => {
    globalThis.fetch = async () => new Response('DNS unavailable', { status: 503 });
    await assert.rejects(resolveImageAttachment(client, part('https://public.example/image'), 0), error => error.status === 503);
    globalThis.fetch = async () => new Response('fixture', { headers: { 'content-type': 'image/png' } });
    assert.equal((await resolveImageAttachment(client, part('https://8.8.8.8/image'), 0)).fileId, 'fixture');
  });
});
