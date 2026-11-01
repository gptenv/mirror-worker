import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Production HTTP adapter, middleware and proxy; only external services are fake.
const directory = mkdtempSync(path.join(tmpdir(), 'mirror-navigation-'));
const production = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const config = path.join(directory, 'wrangler.json');
const assetDirectory = path.resolve(process.env.MIRROR_TEST_ASSETS_DIR || 'apps/web/dist');
async function assets(request) {
  const pathname = new URL(request.url).pathname;
  const file = path.resolve(assetDirectory, '.' + pathname);
  if (!file.startsWith(assetDirectory + path.sep)) return new Response(null, { status: 404 });
  try { return new Response(readFileSync(file), { headers: { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' } }); }
  catch { return new Response(null, { status: 404 }); }
}
writeFileSync(config, JSON.stringify({ name: 'mirror-navigation', main: path.resolve(production.main), compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags, durable_objects: production.durable_objects, migrations: production.migrations }));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: path.join(directory, 'config') };
for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_API_|MIRROR_|OPENAI_API_KEY)/.test(key)) delete env[key];
if (!process.env.MIRROR_TEST_BUNDLE_DIR) execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', config, '--dry-run', '--outdir', path.join(directory, 'bundle')], { env, stdio: 'pipe', timeout: 60_000 });
const options = convertV4MiniflareOptions({ host: '127.0.0.1', https: true, workers: [{
  name: 'mirror-navigation', modules: true,
  scriptPath: path.join(process.env.MIRROR_TEST_BUNDLE_DIR || path.join(directory, 'bundle'), 'cloudflare-worker.js'), modulesRoot: process.env.MIRROR_TEST_BUNDLE_DIR || path.join(directory, 'bundle'),
  compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
  durableObjects: { MIRROR: { className: 'MirrorStorage', useSQLite: true } },
  bindings: { MIRROR_STORE_KEY: 'a'.repeat(64), MIRROR_OWNER_ACCOUNT_ID: 'fixture-owner' },
  serviceBindings: { WARP: 'mirror-navigation-upstream', ASSETS: assets },
  outboundService: () => { throw new Error('Unexpected unbound network access'); },
}, {
  name: 'mirror-navigation-upstream', modules: true, scriptPath: path.resolve('tests/worker/fixtures/upstream.mjs'),
  compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
  serviceBindings: { BACKEND: async request => {
    const url = new URL(request.url);
    const token = request.headers.get('authorization');
    if (url.pathname === '/backend-api/me') {
      if (token === 'Bearer fixture-transient') return new Response('temporarily unavailable', { status: 503 });
      if (!/^Bearer fixture-owner-token(?:-\d+)?$/.test(token || '') && token !== 'Bearer fixture-other-token') return new Response('expired', { status: 401 });
      return Response.json({ object: 'user', id: token === 'Bearer fixture-other-token' ? 'other-user' : 'fixture-owner' });
    }
    if (url.pathname === '/api/auth/session') {
      const cookie = request.headers.get('cookie') || '';
      const rotation = cookie.match(/fixture-rotating-session-(\d+)/);
      if (rotation) return Response.json({ accessToken: 'fixture-owner-token-' + rotation[1] }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=fixture-rotating-session-' + (Number(rotation[1]) + 1) + '; Path=/; Secure' } });
      if (cookie.includes('fixture-wrong-session')) return Response.json({ accessToken: 'fixture-other-token' }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=fixture-wrong-session-rotated; Path=/; Secure' } });
      return cookie.includes('fixture-owner-session') ? Response.json({ accessToken: 'fixture-owner-token' }) : new Response('invalid fixture credential', { status: 401 });
    }
    if (url.pathname === '/api/library/files/libfile_fixture/redirect') return new Response(null, { status: 302, headers: { location: (process.env.MIRROR_TEST_REDIRECT_ORIGIN || 'https://third-party.example') + '/signed-fixture' } });
    if (url.pathname === '/api/library/files/libfile_fixture/redirect-local') return new Response(null, { status: 302, headers: { location: '/api/library/files/libfile_fixture/content' } });
    if (url.pathname === '/api/library/files/libfile_fixture/download-local') return new Response(null, { status: 302, headers: { location: '/api/library/files/libfile_fixture/download' } });
    if (url.pathname === '/unsafe-redirect') return new Response(null, { status: 302, headers: { location: 'https://unsafe.example/collect' } });
    if (/^\/api\/library\/files\/[^/]+\/(?:thumbnail|content|download)$/.test(url.pathname) || url.pathname.startsWith('/backend-api/estuary/')) {
      if (!/^Bearer fixture-owner-token(?:-\d+)?$/.test(token || '')) return new Response('missing upstream auth', { status: 401 });
      const download = url.pathname.endsWith('/download') || url.searchParams.has('download');
      const body = download ? Buffer.from('Spaces fixture file bytes\n') : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWQAAAAASUVORK5CYII=', 'base64');
      const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : body.length - 1;
      return new Response(request.method === 'HEAD' ? null : body.subarray(start, end + 1), { status: range ? 206 : 200, headers: { 'content-type': download ? 'text/plain' : 'image/png', 'content-disposition': download ? 'attachment; filename="Spaces fixture.txt"' : 'inline', 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}) } });
    }
    if (url.pathname === '/space/files') return new Response('<!doctype html><html><head><title>Spaces file list fixture</title></head><body><h1>Files</h1><main id="owner-document">Owner document</main><output id="document-url"></output><script>document.getElementById("document-url").textContent=location.pathname+location.search+location.hash;</script><img id="space-preview" src="/api/library/files/libfile_fixture/thumbnail"><img id="space-full" src="/api/library/files/external-gdrive%3Aaccount%3Afixture%3Aimage/content"><img id="estuary-preview" src="/backend-api/estuary/content?id=fixture"><button id="file-menu" onclick="document.getElementById(\'file-actions\').hidden=false">File actions</button><div id="file-actions" hidden><a role="menuitem" href="/api/library/files/libfile_fixture/download" download>Download</a></div></body></html>', { headers: { 'content-type': 'text/html' } });
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
