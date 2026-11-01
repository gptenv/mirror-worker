import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { stubBackend } from '../../apps/server/tests/helpers/backend.mjs';

// The production bundle runs unchanged in workerd: real cloudflare:node HTTP
// adaptation, Durable Object SQL and AsyncLocalStorage. Only external services
// are synthetic. No production config, credential, remote binding or network
// fallback is provided to the local runtime.
test.describe('worker / local workerd acceptance', { timeout: 120_000 }, () => {
  let directory;
  let runtime;
  let options;
  const upstreamCalls = [];
  test.before(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'mirror-workerd-'));
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: path.join(directory, 'config') };
    for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_API_|MIRROR_|OPENAI_API_KEY)/.test(key)) delete env[key];
    const production = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    const configPath = path.join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ name: 'mirror-local-acceptance', main: path.resolve(production.main), compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags, durable_objects: production.durable_objects, migrations: production.migrations }));
    if (!process.env.MIRROR_TEST_BUNDLE_DIR) execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configPath, '--dry-run', '--outdir', path.join(directory, 'bundle')], { env, stdio: 'pipe', timeout: 60_000 });
    const backend = stubBackend('fixture-owner');
    options = convertV4MiniflareOptions({ host: '127.0.0.1', workers: [{
      name: 'mirror-local-acceptance', modules: true,
      scriptPath: path.join(process.env.MIRROR_TEST_BUNDLE_DIR || path.join(directory, 'bundle'), 'cloudflare-worker.js'), modulesRoot: process.env.MIRROR_TEST_BUNDLE_DIR || path.join(directory, 'bundle'),
      compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
      durableObjects: { MIRROR: { className: 'MirrorStorage', useSQLite: true } },
      bindings: { MIRROR_STORE_KEY: 'a'.repeat(64), MIRROR_OWNER_ACCOUNT_ID: 'fixture-owner' },
      serviceBindings: {
        WARP: 'mirror-fixture-upstream',
        ASSETS: async () => new Response('fixture-static-asset', { headers: { 'content-type': 'text/html' } }),
      },
      outboundService: () => { throw new Error('Unexpected unbound network access'); },
    }, {
      name: 'mirror-fixture-upstream', modules: true,
      scriptPath: path.resolve('tests/worker/fixtures/upstream.mjs'),
      compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
      serviceBindings: { BACKEND: async request => {
          upstreamCalls.push(new URL(request.url).pathname);
          if (new URL(request.url).pathname === '/backend-api/me') {
            const token = request.headers.get('authorization');
            if (token === 'Bearer expired-session' || token === 'Bearer expired-other') return new Response('expired', { status: 401 });
            if (token === 'Bearer transient') return new Response('temporarily unavailable', { status: 503 });
            if (token === 'Bearer edge-challenge') return new Response('just a moment', { status: 403 });
            if (token === 'Bearer invalid-auth') return new Response('Synthetic invalid credential', { status: 401 });
            if (token === 'Bearer missing-identity') return Response.json({ account: { account_user_id: 'fixture-owner' } });
            if (token === 'Bearer malformed-profile') return Response.json({ object: 'user', id: { value: 'fixture-owner' } });
            return Response.json({ object: 'user', id: ['Bearer other-account', 'Bearer fresh-other'].includes(token) ? 'other-user' : 'fixture-owner' });
          }
          if (new URL(request.url).pathname === '/api/auth/session') {
            const cookie = request.headers.get('cookie');
            if (cookie?.includes('expired-session') || cookie?.includes('expired-other'))
              return Response.json({ accessToken: cookie.includes('expired-other') ? 'fresh-other' : 'fresh-owner' }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=fresh-session; Path=/' } });
            return new Response('Synthetic invalid credential', { status: 401 });
          }
          if (/^\/(?:c|g|space)\//.test(new URL(request.url).pathname)) return new Response('<html><body>private fixture thread</body></html>', { headers: { 'content-type': 'text/html' } });
          return backend(request.url, { method: request.method, headers: request.headers, body: request.method === 'GET' ? undefined : await request.text() });
      } },
      outboundService: () => { throw new Error('Unexpected unbound network access'); },
    }] });
    options.resourcePersistencePath = path.join(directory, 'storage');
    options.telemetry = { enabled: false };
    options.cf = false;
    runtime = new Miniflare(options);
    await runtime.ready;
  });
  test.after(async () => {
    await runtime?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const request = (pathname, init = {}) => runtime.dispatchFetch(`https://mirror.example${pathname}`, init);
  const owner = { authorization: 'Bearer fixture-owner' };
  const navigate = async (url, headers = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' }) => {
    // Node fetch overwrites Sec-Fetch-Mode with cors. Use raw HTTP to model
    // the headers an actual browser navigation sends to the Worker.
    const { request: httpRequest } = await import('node:http');
    const base = await runtime.ready;
    return new Promise((resolve, reject) => {
      const req = httpRequest(new URL(url, base), { headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
        res.on('error', reject);
      });
      req.on('error', reject); req.end();
    });
  };


  test('refresh headers survive the real HTTP SSE bridge, with repeated owner verification', async () => {
    for (const [pathname, payload] of [
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'fixture' }], stream: true }],
      ['/v1/responses', { input: 'fixture', stream: true }],
      ['/api/chat', { prompt: 'fixture' }],
    ]) {
      const response = await request(pathname, { method: 'POST', headers: { authorization: 'Bearer expired-session', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-mirror-access-token'), 'fresh-owner');
      assert.equal(response.headers.get('x-mirror-session-token'), 'fresh-session');
      assert.equal(response.headers.get('x-mirror-auth-status'), 'owner_verified');
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.match(await response.text(), /reply-/);
    }
    const wrong = await request('/api/diagnostics', { headers: { authorization: 'Bearer expired-other' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers.get('x-mirror-auth-status'), 'owner_mismatch');
    assert.equal(wrong.headers.get('x-mirror-access-token'), null);
    assert.equal(wrong.headers.get('x-mirror-session-token'), null);
    for (const [token, status] of [['transient', 503], ['edge-challenge', 403]]) {
      const before = upstreamCalls.length;
      const failed = await request('/api/diagnostics', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(failed.status, status);
      assert.equal((await failed.json()).error.type, 'upstream_error');
      assert.equal(upstreamCalls.length, before + 1);
    }
  });
  test('rejects websocket upgrades before contacting upstream', async () => {
    const before = upstreamCalls.length;
    const response = await request('/backend-api/celsius/ws', { headers: { upgrade: 'websocket' } });
    assert.equal(response.status, 501);
    assert.match(await response.text(), /WebSocket proxying is disabled/);
    assert.equal(upstreamCalls.length, before);
  });
  test('reconnect shell is public while its document stays owner-protected', async () => {
    const before = upstreamCalls.length;
    const shell = await navigate('/mirror/playground');
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /<form id="connect">/);
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /fixture-static-asset/);
    assert.equal(upstreamCalls.length, before);
    const documentHeaders = { accept: 'text/html', 'x-mirror-document': '1' };
    assert.equal((await request('/mirror/playground', { headers: documentHeaders })).status, 401);
    for (const [token, status] of [['invalid-auth', 401], ['other-account', 403]]) {
      const denied = await request('/mirror/playground', { headers: { ...documentHeaders, authorization: `Bearer ${token}` } });
      assert.equal(denied.status, status);
      assert.doesNotMatch(await denied.text(), /fixture-static-asset/);
    }
    const accepted = await request('/mirror/playground', { headers: { ...documentHeaders, ...owner } });
    assert.equal(accepted.status, 200);
    assert.equal(await accepted.text(), 'fixture-static-asset');
  });
  test('external links and thread URLs expose only the shell until the owner authenticates', async () => {
    const navigation = { accept: 'text/html', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (const url of ['/space/', '/space/files', '/space/d/external-gdrive%3Aaccount%3Afixture%3Aroot', '/c/fixture-thread?view=thread', '/g/g-fixture/c/fixture-thread', '/g/g-p-fixture/project']) {
      const before = upstreamCalls.length;
      const shell = await navigate(url);
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /<form id="connect">/);
      assert.equal(upstreamCalls.length, before);
      const document = { accept: 'text/html', 'x-mirror-document': '1' };
      assert.equal((await request(url, { headers: document })).status, 401);
      const other = await request(url, { headers: { ...document, authorization: 'Bearer other-account' } });
      assert.equal(other.status, 403);
      assert.doesNotMatch(await other.text(), /private fixture thread/);
      const accepted = await request(url, { headers: { ...document, ...owner } });
      assert.equal(accepted.status, 200);
      assert.match(await accepted.text(), /private fixture thread/);
      assert.equal(upstreamCalls.at(-1), url.split('?')[0]);
    }
    for (const headers of [
      { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
      { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    ]) {
      const shell = await navigate('/space/files?view=all', headers);
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /<form id="connect">/);
    }
    for (const url of ['/api/conversations', '/backend-api/conversation/fixture-thread']) {
      assert.equal((await request(url, { headers: navigation })).status, 401);
    }
    assert.equal((await request('/api/conversations', { method: 'POST', headers: { ...owner, origin: 'https://external.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  });
  test('HTTP adapter enforces owner access and saves settings across runtime restart', async () => {
    assert.equal((await request('/api/diagnostics')).status, 401);
    assert.equal((await request('/api/diagnostics', { headers: { authorization: 'Bearer other-account' } })).status, 403);
    for (const [token, status] of [['missing-identity', 502], ['malformed-profile', 502], ['invalid-auth', 401]]) {
      assert.equal((await request('/api/diagnostics', { headers: { authorization: `Bearer ${token}` } })).status, status);
    }
    const session = await request('/api/session', { method: 'POST', headers: owner });
    assert.equal(session.status, 200, await session.text());
    const saved = await request('/api/settings/default-system-instructions', { method: 'PUT', headers: { ...owner, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Synthetic persisted instruction' }) });
    assert.equal(saved.status, 200, await saved.text());
    await runtime.dispose();
    runtime = new Miniflare(options);
    const restored = await request('/api/settings/default-system-instructions', { headers: owner });
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), { content: 'Synthetic persisted instruction' });
    const diagnostics = await request('/api/diagnostics', { headers: owner });
    assert.equal(diagnostics.status, 200);
    // Version 1 is the released baseline; a migration must update this acceptance fixture.
    assert.equal((await diagnostics.json()).storage.schemaVersion, 1);
    assert.ok(upstreamCalls.includes('/backend-api/me'));
  });
  test('JSON and SSE completions retain their transcript through the real HTTP bridge', async () => {
    for (const stream of [false, true]) {
      const completion = await request('/v1/chat/completions', {
        method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'Synthetic local prompt' }], stream }),
      });
      const body = await completion.text();
      assert.equal(completion.status, 200, body);
      assert.doesNotMatch(body, /"error":/);
      assert.match(body, /reply-/);
      const id = stream ? body.match(/: mirror-conversation-id ([^\n]+)/)?.[1] : completion.headers.get('x-mirror-conversation-id');
      assert.ok(id, body);
      if (stream) { assert.match(body, /"finish_reason":"stop"/); assert.match(body, /data: \[DONE\]/); }
      const exported = await request(`/api/conversations/${id}/export?format=json`, { headers: owner });
      assert.equal(exported.status, 200);
      assert.match(await exported.text(), /Synthetic local prompt/);
    }
  });

  test('a real HTTP client disconnect cancels upstream by the next heartbeat and preserves the completed parent for retry', { timeout: 25_000 }, async () => {
    const base = await runtime.ready;
    const id = 'fixture-http-disconnect';
    const post = (content, stream, signal) => fetch(new URL('/v1/chat/completions', base), {
      method: 'POST', headers: { ...owner, 'content-type': 'application/json', 'accept-encoding': 'identity' }, signal,
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content }], metadata: { conversation_id: id }, stream }),
    });
    const initial = await post('Seed completed parent', false, AbortSignal.timeout(3000));
    assert.equal(initial.status, 200, await initial.text());
    const before = await (await request(`/api/conversations/${id}`, { headers: owner })).json();
    const fixture = await runtime.getWorker('mirror-fixture-upstream');
    await fixture.fetch('https://fixture.example/__fixture/arm');
    const controller = new AbortController();
    let reader;
    const bounded = async (promise, label, timeout = 3000) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      const streaming = await post('Disconnect after a partial answer', true, controller.signal);
      assert.equal(streaming.status, 200);
      reader = streaming.body.getReader();
      let received = '';
      while (!received.includes('fixture-partial-answer')) {
        const chunk = await bounded(reader.read(), 'No partial text reached the actual HTTP client');
        assert.equal(chunk.done, false);
        received += new TextDecoder().decode(chunk.value);
      }
      assert.equal((await (await fixture.fetch('https://fixture.example/__fixture/status')).json()).cancelled, false,
        'upstream stream must still be active before client disconnection');
      const activeTurn = await (await request(`/api/conversations/${id}`, { headers: owner })).json();
      assert.equal(activeTurn.messages.at(-1).status, 'streaming', 'fixture must not fail before client disconnection');
      controller.abort();
      await reader.cancel().catch(() => {});
      // Local workerd observes a disconnected silent client on its next
      // write. Allow the production 10s heartbeat plus bounded scheduling
      // slack; a 3s silent interval does not establish a lifecycle failure.
      const cancelDeadline = Date.now() + 13_000;
      let nativeState;
      do {
        nativeState = await (await fixture.fetch('https://fixture.example/__fixture/status')).json();
        if (nativeState.cancelled) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < cancelDeadline);
      if (!nativeState.cancelled) {
        const state = await (await request(`/api/conversations/${id}`, { headers: owner })).json();
        throw new Error(`Native upstream did not cancel after heartbeat; serviceSignalAborted=${nativeState.signalAborted}; assistantStatus=${state.messages.at(-1).status}`);
      }
      let after;
      const until = Date.now() + 3000;
      do {
        after = await (await request(`/api/conversations/${id}`, { headers: owner })).json();
        if (after.messages.at(-1).status !== 'streaming') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < until);
      assert.equal(after.messages.at(-1).status, 'stopped');
      assert.equal(after.messages.at(-1).content, 'fixture-partial-answer\n');
      assert.equal(after.conversation.currentNodeId, before.conversation.currentNodeId);
      const retry = await post('Retry after disconnect', false, AbortSignal.timeout(3000));
      assert.equal(retry.status, 200, await retry.text());
      const recovered = await (await request(`/api/conversations/${id}`, { headers: owner })).json();
      assert.equal(recovered.messages.at(-1).status, 'finished_successfully');
      assert.notEqual(recovered.conversation.currentNodeId, before.conversation.currentNodeId);
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await fixture.fetch('https://fixture.example/__fixture/cleanup');
    }
  });

});
