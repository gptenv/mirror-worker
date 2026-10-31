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
    options = convertV4MiniflareOptions({
      name: 'mirror-local-acceptance', host: '127.0.0.1', modules: true,
      scriptPath: path.join(directory, 'bundle/cloudflare-worker.js'), modulesRoot: path.join(directory, 'bundle'),
      compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { MIRROR: { className: 'MirrorStorage', useSQLite: true } },
      bindings: { MIRROR_STORE_KEY: 'a'.repeat(64), MIRROR_OWNER_ACCOUNT_ID: 'fixture-owner' },
      serviceBindings: {
        WARP: async request => {
          upstreamCalls.push(new URL(request.url).pathname);
          if (request.headers.get('authorization') === 'Bearer other-account') return Response.json({ account: { account_user_id: 'other-account' } });
          return backend(request.url, { method: request.method, headers: request.headers, body: request.method === 'GET' ? undefined : await request.text() });
        },
        ASSETS: async () => new Response('fixture-static-asset', { headers: { 'content-type': 'text/html' } }),
      },
      outboundService: () => { throw new Error('Unexpected unbound network access'); },
    });
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

});
