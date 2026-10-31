import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { registerHooks } from 'node:module';

// Node cannot load Cloudflare's built-in modules. Map only those platform
// imports to small adapters; a separate test exercises the real runtime.
const fixtureModules = new Map([
  [new URL('../dist/index.js', import.meta.url).href, new URL('./helpers/worker-entrypoint-app.mjs', import.meta.url).href],
  [new URL('../dist/store.js', import.meta.url).href, new URL('./helpers/worker-entrypoint-store.mjs', import.meta.url).href],
]);
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
  if (specifier === 'cloudflare:node') return { url: 'data:text/javascript,export const httpServerHandler = server => ({ fetch: request => server.fetch(request) });', shortCircuit: true };
  const resolved = next(specifier, context);
  return fixtureModules.has(resolved.url) ? { ...resolved, url: fixtureModules.get(resolved.url) } : resolved;
} });
let starts = 0;
let shouldFail = false;
let initialized = 0;
// Give generated mock modules fixture URLs: Node's ?node-test-mock modules
// contain different code, so mapping their offsets onto production source
// would invent uncovered import branches in the c8 report.
mock.module('./helpers/worker-entrypoint-app.mjs', { exports: { buildApp: async (options) => {
  starts++;
  if (shouldFail) { shouldFail = false; throw new Error('fixture startup failure'); }
  return { ready: async () => {}, server: { fetch: async request => Response.json({ owner: options.ownerAccountId, authorization: request.headers.get('authorization') }) } };
} } });
mock.module('./helpers/worker-entrypoint-store.mjs', { exports: { initializeWorkerStore: () => { initialized++; }, getOrCreateDeviceId: () => 'fixture-device' } });
const { MirrorStorage, default: worker } = await import('../dist/cloudflare-worker.js');
const env = { MIRROR_OWNER_ACCOUNT_ID: ' owner ', MIRROR_STORE_KEY: 'fixture', WARP: { fetch: async () => new Response() }, ASSETS: {} };

test.describe('server / cloudflare-worker entrypoint', () => {
  test('requires an owner before initializing storage', () => {
    const before = initialized;
    assert.throws(() => new MirrorStorage({ storage: {} }, { ...env, MIRROR_OWNER_ACCOUNT_ID: ' ' }), /MIRROR_OWNER_ACCOUNT_ID/);
    assert.equal(initialized, before);
  });
  test('rejects upgrades and retries a failed application startup', async () => {
    const instance = new MirrorStorage({ storage: {} }, env);
    assert.equal((await instance.fetch(new Request('https://mirror.example/ws', { headers: { upgrade: 'websocket' } }))).status, 501);
    shouldFail = true;
    const normal = () => new Request('https://mirror.example/api', { headers: { authorization: 'Bearer fixture', 'x-mirror-session-token': 'session' } });
    await assert.rejects(instance.fetch(normal()), /fixture startup failure/);
    const response = await instance.fetch(normal());
    assert.deepEqual(await response.json(), { owner: 'owner', authorization: 'Bearer fixture' });
    const count = starts;
    await instance.fetch(normal());
    assert.equal(starts, count, 'successful server is reused by its Durable Object');
    const anonymous = await instance.fetch(new Request('https://mirror.example/api'));
    assert.equal((await anonymous.json()).authorization, null);
    const other = new MirrorStorage({ storage: {} }, env);
    await other.fetch(normal());
    assert.equal(starts, count + 1, 'different Durable Objects do not share an HTTP server');
  });
  test('replaces untrusted forwarding headers before addressing the singleton', async () => {
    let forwarded;
    const runtime = { MIRROR: { idFromName: name => { assert.equal(name, 'mirror-single-account'); return 'id'; }, get: id => { assert.equal(id, 'id'); return { fetch: async req => { forwarded = req; return new Response('ok'); } }; } } };
    const response = await worker.fetch(new Request('https://mirror.example/path', { headers: { forwarded: 'bad', 'x-forwarded-for': 'bad', 'x-forwarded-host': 'bad', 'x-forwarded-proto': 'bad', 'x-real-ip': 'bad', 'cf-connecting-ip': '192.0.2.1' } }), runtime);
    assert.equal(await response.text(), 'ok');
    assert.equal(forwarded.headers.get('forwarded'), null);
    assert.equal(forwarded.headers.get('x-real-ip'), null);
    assert.equal(forwarded.headers.get('x-forwarded-for'), '192.0.2.1');
    assert.equal(forwarded.headers.get('x-forwarded-host'), 'mirror.example');
    assert.equal(forwarded.headers.get('x-forwarded-proto'), 'https');
    await worker.fetch(new Request('https://mirror.example/'), runtime);
    assert.equal(forwarded.headers.get('x-forwarded-for'), null);
  });
});
