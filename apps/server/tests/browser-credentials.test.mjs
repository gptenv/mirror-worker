import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { BROWSER_BOOTSTRAP } from '../dist/browser-bootstrap.js';
import { EARLY_PATCH } from '../dist/browser-patch.js';
import { injectionJs } from '../dist/mirror-controls.js';

const script = html => html.match(/<script>([\s\S]*)<\/script>/)[1];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t, fetch = async () => Response.json({ configured: true })) {
  const dom = new JSDOM('<aside><div><div><button data-testid="accounts-profile-button">Account</button></div></div></aside>', { url: 'https://mirror.example/' });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { get() { return this.parentElement; } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 200, height: 40, top: 100, left: 0 });
  const storage = dom.window.localStorage;
  storage.setItem('mirror_access_token', 'old-access');
  storage.setItem('mirror_session_token', 'old-session');
  class Xhr extends EventTarget {
    open() { this.headers = new Headers(); this.responseHeaders = new Headers(); }
    setRequestHeader(name, value) { this.headers.append(name, value); }
    send() {}
    getResponseHeader(name) { return this.responseHeaders.get(name); }
    finish(headers) { this.responseHeaders = new Headers(headers); this.dispatchEvent(new Event('loadend')); }
  }
  let reloads = 0;
  const context = vm.createContext({
    Headers, URL, Request, Response, XMLHttpRequest: Xhr, fetch,
    localStorage: storage, document: dom.window.document,
    location: { href: 'https://mirror.example/', origin: 'https://mirror.example', protocol: 'https:', host: 'mirror.example', reload() { reloads++; } },
    navigator: {}, addEventListener() {}, setInterval() {}, clearInterval() {}, setTimeout() {},
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), innerHeight: 800,
    __mirrorDecoderInstalled: true,
  });
  context.window = context;
  return { context, storage, get reloads() { return reloads; }, patch() { vm.runInContext(script(EARLY_PATCH), context); }, controls() { vm.runInContext(injectionJs, context); },
    save(token) { context.document.querySelector('textarea').value = token; return context.document.querySelector('.mirror-save').onclick(); },
    status() { return context.document.querySelector('.mirror-status').textContent; },
  };
}
const pair = f => [f.storage.getItem('mirror_access_token'), f.storage.getItem('mirror_session_token')];
const rotated = { 'x-mirror-access-token': 'rotated-access', 'x-mirror-session-token': 'rotated-session' };

test.describe('server / injected browser credentials', () => {
  test('bootstrap rejects old credentials both before response headers and while the document body loads', async t => {
    for (const changeDuringBody of [false, true]) {
      const gate = deferred();
      const body = deferred();
      const f = fixture(t, () => gate.promise);
      let written = false;
      const status = { textContent: '' };
      f.context.document = { open() {}, close() {}, write() { written = true; }, getElementById() { return status; } };
      const run = vm.runInContext(script(BROWSER_BOOTSTRAP), f.context);
      if (changeDuringBody) {
        gate.resolve({ headers: new Headers(rotated), ok: true, text: () => body.promise });
        await Promise.resolve();
      }
      f.storage.setItem('mirror_access_token', 'replacement');
      f.storage.setItem('mirror_session_token', 'replacement-session');
      if (changeDuringBody) body.resolve('<html>old account</html>');
      else gate.resolve(new Response('<html>old account</html>', { headers: rotated }));
      await run;
      assert.deepEqual(pair(f), ['replacement', 'replacement-session']);
      assert.equal(written, false, 'old account HTML must not replace the current document');
      assert.match(status.textContent, /Credentials changed/);
    }
  });

  test('bootstrap keeps valid access/session-only refreshes and never stores an absent fallback token', async t => {
    for (const initial of ['bearer', 'empty']) {
      const f = fixture(t, async () => new Response('<html>current</html>', { headers: { 'x-mirror-access-token': 'fresh' } }));
      f.storage.clear();
      if (initial === 'bearer') f.storage.setItem('mirror_access_token', 'old');
      let written;
      f.context.document = { open() {}, close() {}, write(html) { written = html; }, getElementById() { throw Error('unexpected bootstrap error'); } };
      await vm.runInContext(script(BROWSER_BOOTSTRAP), f.context);
      assert.deepEqual(pair(f), ['fresh', initial === 'bearer' ? 'old' : null]);
      assert.equal(written, '<html>current</html>');
    }
    const f = fixture(t, async () => new Response('current', { headers: { 'x-mirror-session-token': 'fresh-session' } }));
    f.context.document = { open() {}, close() {}, write() {}, getElementById() { throw Error('unexpected error'); } };
    await vm.runInContext(script(BROWSER_BOOTSTRAP), f.context);
    assert.deepEqual(pair(f), ['old-access', 'fresh-session']);
  });

  test('bootstrap preserves accepted credential refresh when the document body is interrupted', async t => {
    const f = fixture(t, async () => ({ headers: new Headers(rotated), ok: true, text: async () => { throw Error('interrupted HTML body'); } }));
    const status = { textContent: '' };
    f.context.document = { open() { assert.fail('must not render an interrupted document'); }, getElementById() { return status; } };
    await vm.runInContext(script(BROWSER_BOOTSTRAP), f.context);
    assert.deepEqual(pair(f), ['rotated-access', 'rotated-session']);
    assert.equal(status.textContent, 'interrupted HTML body');
  });

  for (const transport of ['fetch', 'XHR']) {
    test(`${transport} ignores stale access/session rotations after replacement, logout, or another rotation`, async t => {
      for (const responseHeaders of [rotated, { 'x-mirror-session-token': 'stale-session-only' }]) {
      for (const changed of ['bearer', 'session', 'clear']) {
        const gate = deferred();
        const f = fixture(t, () => gate.promise); f.patch();
        const xhr = new f.context.XMLHttpRequest();
        let request;
        if (transport === 'fetch') request = f.context.fetch('/backend-api/models');
        else { xhr.open('GET', '/backend-api/models'); xhr.send(); }
        if (changed === 'clear') f.storage.clear();
        if (changed === 'bearer') f.storage.setItem('mirror_access_token', 'replacement');
        if (changed === 'session') f.storage.setItem('mirror_session_token', 'replacement-session');
        const current = pair(f);
        if (transport === 'fetch') { gate.resolve(Response.json({}, { headers: responseHeaders })); await request; }
        else xhr.finish(responseHeaders);
        assert.deepEqual(pair(f), current, changed);
      }
      }
    });

    test(`${transport} preserves current rotations, session-only refresh, and ignores external headers`, async t => {
      let responseHeaders = rotated;
      const f = fixture(t, async (_input, init) => { assert.equal(init.headers.get('authorization'), 'Bearer old-access'); return Response.json({}, { headers: responseHeaders }); });
      f.patch();
      const xhr = new f.context.XMLHttpRequest();
      async function send(url) {
        if (transport === 'fetch') return f.context.fetch(url);
        xhr.open('GET', url); xhr.send(); xhr.finish(responseHeaders);
      }
      await send('/backend-api/models');
      assert.deepEqual(pair(f), ['rotated-access', 'rotated-session']);
      f.storage.setItem('mirror_access_token', 'old-access');
      responseHeaders = { 'x-mirror-session-token': 'session-only' };
      await send('/backend-api/models');
      assert.deepEqual(pair(f), ['old-access', 'session-only']);
      // A reused XHR must not leave a previous same-origin listener attached.
      responseHeaders = { 'x-mirror-access-token': 'hostile' };
      if (transport === 'fetch') f.context.fetch = async () => Response.json({}, { headers: responseHeaders });
      await send('https://external.example/models');
      assert.deepEqual(pair(f), ['old-access', 'session-only']);
    });
  }

  test('reusing an XHR after a response without rotation cannot accept external credentials', t => {
    const f = fixture(t); f.patch();
    const xhr = new f.context.XMLHttpRequest();
    xhr.open('GET', '/backend-api/models'); xhr.send(); xhr.finish({});
    xhr.open('GET', 'https://external.example/models'); xhr.send(); xhr.finish(rotated);
    assert.deepEqual(pair(f), ['old-access', 'old-session']);
  });
  test('reopening a pending XHR removes its previous credential listener', t => {
    const f = fixture(t); f.patch();
    const xhr = new f.context.XMLHttpRequest();
    xhr.open('GET', '/backend-api/models'); xhr.send();
    xhr.open('GET', 'https://external.example/models'); xhr.send(); xhr.finish(rotated);
    assert.deepEqual(pair(f), ['old-access', 'old-session']);
  });

  test('a failed older save cannot clear a newer credential or overwrite its pending status', async t => {
    const first = deferred(), second = deferred();
    let count = 0;
    const f = fixture(t, (_url, init) => init?.method === 'POST' ? (++count === 1 ? first.promise : second.promise) : Promise.resolve(Response.json({ configured: true })));
    f.patch(); f.controls();
    const old = f.save('old-submission');
    const newer = f.save('new-submission');
    first.resolve(Response.json({ error: 'old denied' }, { status: 401 })); await old;
    assert.deepEqual(pair(f), ['new-submission', null]);
    assert.equal(f.status(), 'Verifying…');
    second.resolve(Response.json({ ok: true }, { headers: rotated })); await newer;
    assert.deepEqual(pair(f), ['rotated-access', 'rotated-session']);
    assert.equal(f.reloads, 1);
  });

  test('save failure clears its own credential but preserves external changes during response parsing', async t => {
    const f = fixture(t, async (_url, init) => init?.method === 'POST' ? Response.json({ error: 'denied' }, { status: 401 }) : Response.json({ configured: true }));
    f.patch(); f.controls();
    await f.save('bad-submission');
    assert.deepEqual(pair(f), [null, null]); assert.equal(f.status(), 'denied');
    const body = deferred();
    f.context.fetch = async () => ({ headers: new Headers(), ok: false, json: () => body.promise });
    const stale = f.save('old-submission');
    await Promise.resolve(); await Promise.resolve();
    f.storage.setItem('mirror_access_token', 'other-tab');
    f.storage.setItem('mirror_session_token', 'other-session');
    body.resolve({ error: 'late denied' }); await stale;
    assert.deepEqual(pair(f), ['other-tab', 'other-session']);
    assert.match(f.status(), /Credentials changed/); assert.equal(f.reloads, 0);
  });

  test('stale successful saves cannot reload over a newer credential', async t => {
    const gate = deferred();
    const f = fixture(t, (_url, init) => init?.method === 'POST' ? gate.promise : Promise.resolve(Response.json({ configured: true })));
    f.patch(); f.controls();
    const run = f.save('submitted');
    f.storage.setItem('mirror_access_token', 'replacement');
    gate.resolve(Response.json({ ok: true }, { headers: rotated })); await run;
    assert.deepEqual(pair(f), ['replacement', null]);
    assert.equal(f.reloads, 0); assert.match(f.status(), /Credentials changed/);
  });
});
