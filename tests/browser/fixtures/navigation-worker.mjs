import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Production HTTP adapter, middleware and proxy; only external services are fake.
const directory = mkdtempSync(path.join(tmpdir(), 'mirror-navigation-'));
const production = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const config = path.join(directory, 'wrangler.json');
writeFileSync(config, JSON.stringify({ name: 'mirror-navigation', main: path.resolve(production.main), compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags, durable_objects: production.durable_objects, migrations: production.migrations }));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: path.join(directory, 'config') };
for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_API_|MIRROR_|OPENAI_API_KEY)/.test(key)) delete env[key];
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', config, '--dry-run', '--outdir', path.join(directory, 'bundle')], { env, stdio: 'pipe', timeout: 60_000 });
const options = convertV4MiniflareOptions({ host: '127.0.0.1', https: true, workers: [{
  name: 'mirror-navigation', modules: true,
  scriptPath: path.join(directory, 'bundle/cloudflare-worker.js'), modulesRoot: path.join(directory, 'bundle'),
  compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
  durableObjects: { MIRROR: { className: 'MirrorStorage', useSQLite: true } },
  bindings: { MIRROR_STORE_KEY: 'a'.repeat(64), MIRROR_OWNER_ACCOUNT_ID: 'fixture-owner' },
  serviceBindings: { WARP: 'mirror-navigation-upstream', ASSETS: async () => new Response('<!doctype html><html><body><main id="owner-document">Playground</main></body></html>', { headers: { 'content-type': 'text/html' } }) },
  outboundService: () => { throw new Error('Unexpected unbound network access'); },
}, {
  name: 'mirror-navigation-upstream', modules: true, scriptPath: path.resolve('tests/worker/fixtures/upstream.mjs'),
  compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
  serviceBindings: { BACKEND: async request => {
    const url = new URL(request.url);
    const token = request.headers.get('authorization');
    if (url.pathname === '/backend-api/me') {
      if (token === 'Bearer fixture-transient') return new Response('temporarily unavailable', { status: 503 });
      if (!['Bearer fixture-owner-token', 'Bearer fixture-other-token'].includes(token)) return new Response('expired', { status: 401 });
      return Response.json({ object: 'user', id: token === 'Bearer fixture-owner-token' ? 'fixture-owner' : 'other-user' });
    }
    if (url.pathname === '/api/auth/session') return new Response('invalid fixture credential', { status: 401 });
    if (url.pathname === '/unsafe-redirect') return new Response(null, { status: 302, headers: { location: 'https://unsafe.example/collect' } });
    if (url.pathname.startsWith('/backend-api/')) return Response.json({ fixture: true });
    return new Response('<!doctype html><html><head><title>Fixture document</title></head><body><main id="owner-document">Owner document</main><output id="document-url"></output><a id="internal" href="/library">Library</a><script>document.getElementById("document-url").textContent=location.pathname+location.search+location.hash;document.getElementById("internal").onclick=function(e){e.preventDefault();history.pushState({},"","/library");document.getElementById("document-url").textContent=location.pathname;}</script></body></html>', { headers: { 'content-type': 'text/html' } });
  } },
  outboundService: () => { throw new Error('Unexpected unbound network access'); },
}] });
options.resourcePersistencePath = path.join(directory, 'storage');
options.telemetry = { enabled: false }; options.cf = false;
const runtime = new Miniflare(options);
process.send({ url: String(await runtime.ready) });
let closing = false;
async function close() { if (closing) return; closing = true; await runtime.dispose(); rmSync(directory, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', close); process.on('disconnect', close);
