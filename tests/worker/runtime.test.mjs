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
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configPath, '--dry-run', '--outdir', path.join(directory, 'bundle')], { env, stdio: 'pipe', timeout: 60_000 });
    const backend = stubBackend('fixture-owner');
    options = convertV4MiniflareOptions({ host: '127.0.0.1', workers: [{
      name: 'mirror-local-acceptance', modules: true,
      scriptPath: path.join(directory, 'bundle/cloudflare-worker.js'), modulesRoot: path.join(directory, 'bundle'),
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
          if (request.headers.get('authorization') === 'Bearer other-account') return Response.json({ account: { account_user_id: 'other-account' } });
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

  test('rejects websocket upgrades before contacting upstream', async () => {
    const before = upstreamCalls.length;
    const response = await request('/backend-api/celsius/ws', { headers: { upgrade: 'websocket' } });
    assert.equal(response.status, 501);
    assert.match(await response.text(), /WebSocket proxying is disabled/);
    assert.equal(upstreamCalls.length, before);
  });
  test('HTTP adapter enforces owner access and saves settings across runtime restart', async () => {
    assert.equal((await request('/api/diagnostics')).status, 401);
    assert.equal((await request('/api/diagnostics', { headers: { authorization: 'Bearer other-account' } })).status, 403);
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
