import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

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

globalThis.__testStarts = 0;
globalThis.__testShouldFail = false;

const { MirrorStorage, default: worker } = await import('../dist/cloudflare-worker.js');
const env = { MIRROR_STORE_KEY: 'fixture', WARP: { fetch: async () => new Response() }, ASSETS: {} };

test.describe('server / cloudflare-worker entrypoint', () => {
  test('rejects websocket upgrades', async () => {
    const instance = new MirrorStorage({ storage: {} }, env);
    const response = await instance.fetch(new Request('https://mirror.example/ws', { headers: { upgrade: 'websocket' } }));
    assert.equal(response.status, 501);
  });

  test('starts server and reuses it, covers WARP present and absent', async () => {
    const instance = new MirrorStorage({ storage: {} }, env);
    const req = new Request('https://mirror.example/api', { headers: { authorization: 'Bearer fixture', 'x-mirror-session-token': 'session' } });
    const response = await instance.fetch(req);
    const body = await response.json(); assert.equal(body.authorization, 'Bearer fixture');
    assert.equal(globalThis.__testStarts, 1);

    // reuse
    await instance.fetch(req);
    assert.equal(globalThis.__testStarts, 1);

    // no authorization
    const anon = await instance.fetch(new Request('https://mirror.example/api'));
    assert.equal((await anon.json()).authorization, null);

    // bad authorization
    const bad = await instance.fetch(new Request('https://mirror.example/api', { headers: { authorization: 'Basic xxx' } }));
    assert.equal((await bad.json()).authorization, 'Basic xxx');

    // no WARP
    const envNoWarp = { ...env };
    delete envNoWarp.WARP;
    const instance2 = new MirrorStorage({ storage: {} }, envNoWarp);
    const response2 = await instance2.fetch(req);
    assert.equal((await response2.json()).authorization, 'Bearer fixture');
    assert.equal(globalThis.__testStarts, 1); // shared across DOs
  });

  test('strips untrusted forwarding headers', async () => {
    let forwarded;
    const runtime = {
      MIRROR: {
        idFromName: name => {
          assert.equal(name, 'mirror-single-account');
          return 'id';
        },
        get: id => {
          assert.equal(id, 'id');
          return {
            fetch: async req => {
              forwarded = req;
              return new Response('ok');
            }
          };
        }
      }
    };
    const response = await worker.fetch(new Request('https://mirror.example/path', {
      headers: {
        forwarded: 'bad',
        'x-forwarded-for': 'bad',
        'x-forwarded-host': 'bad',
        'x-forwarded-proto': 'bad',
        'x-real-ip': 'bad',
        'cf-connecting-ip': '192.0.2.1'
      }
    }), runtime);
    assert.equal(await response.text(), 'ok');
    assert.equal(forwarded.headers.get('forwarded'), null);
    assert.equal(forwarded.headers.get('x-real-ip'), null);
    assert.equal(forwarded.headers.get('x-forwarded-for'), '192.0.2.1');
    assert.equal(forwarded.headers.get('x-forwarded-host'), 'mirror.example');
    assert.equal(forwarded.headers.get('x-forwarded-proto'), 'https');

    // no client ip
    await worker.fetch(new Request('https://mirror.example/'), runtime);
    assert.equal(forwarded.headers.get('x-forwarded-for'), null);
  });
});
