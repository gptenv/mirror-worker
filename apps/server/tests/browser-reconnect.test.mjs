import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { BROWSER_BOOTSTRAP } from '../dist/browser-bootstrap.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const rotated = { 'content-type': 'text/html', 'x-mirror-access-token': 'fixture-fresh-access', 'x-mirror-session-token': 'fixture-fresh-session' };
function fixture(t, fetch, initial = []) {
  const dom = new JSDOM(BROWSER_BOOTSTRAP, { url: 'https://mirror.example/mirror/playground', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.Headers = Headers;
  window.fetch = fetch;
  const storage = window.localStorage;
  if (initial[0]) storage.setItem('mirror_access_token', initial[0]);
  if (initial[1]) storage.setItem('mirror_session_token', initial[1]);
  let rendered;
  window.document.open = () => {};
  window.document.write = html => { rendered = html; };
  window.document.close = () => {};
  const input = window.document.getElementById('credential');
  const form = window.document.getElementById('connect');
  return { storage, input, form, get rendered() { return rendered; },
    run: () => window.eval(window.document.querySelector('script').textContent),
    status: () => window.document.getElementById('status').textContent,
    disabled: () => window.document.getElementById('submit').disabled,
    pair: () => [storage.getItem('mirror_access_token'), storage.getItem('mirror_session_token')],
    submit(token) { input.value = token; return form.onsubmit({ preventDefault() {} }); },
    body: () => window.document.body.innerHTML,
  };
}

test.describe('server / browser reconnect', () => {
  test('fresh and reset browsers show credential entry without a protected request', async t => {
    for (const reset of [false, true]) {
      const f = fixture(t, () => assert.fail('no credential must not fetch protected HTML'), reset ? ['old-access', 'old-session'] : []);
      if (reset) f.storage.clear();
      await f.run();
      assert.equal(f.input.type, 'password');
      assert.equal(f.input.getAttribute('name'), null, 'native form submission cannot put a credential in the URL');
      assert.match(f.status(), /Enter your credential/);
      assert.equal(f.disabled(), false);
      await f.submit('  ');
      assert.deepEqual(f.pair(), [null, null]);
      assert.equal(f.rendered, undefined);
    }
  });

  test('reconnect verifies a candidate before persisting it and renders the accepted document', async t => {
    const gate = deferred();
    const f = fixture(t, async (url, init) => {
      assert.equal(url, 'https://mirror.example/mirror/playground');
      assert.equal(init.headers.get('authorization'), 'Bearer fixture-submitted');
      assert.equal(init.headers.get('x-mirror-document'), '1');
      assert.equal(init.headers.get('x-mirror-session-token'), null);
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      return gate.promise;
    });
    await f.run();
    const connecting = f.submit('  fixture-submitted  ');
    assert.equal(f.input.value, '');
    assert.deepEqual(f.pair(), [null, null]);
    gate.resolve(new Response('<main>Accepted owner document</main>', { headers: rotated }));
    await connecting;
    assert.equal(f.rendered, '<main>Accepted owner document</main>');
    assert.deepEqual(f.pair(), ['fixture-fresh-access', 'fixture-fresh-session']);
  });

  test('successful data documents render inert text rather than executable markup', async t => {
    const body = '<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>';
    for (const type of ['application/json', 'application/yaml', 'text/plain', '']) {
      const f = fixture(t, async () => ({ ok: true, headers: new Headers({ 'content-type': type }), text: async () => body }), ['owner']);
      await f.run();
      assert.equal(f.rendered, undefined);
      assert.match(f.body(), /&lt;img/);
      assert.doesNotMatch(f.body(), /<img|<script/);
    }
  });
  test('invalid credentials, wrong owners and server failures keep a usable form and never render raw error data', async t => {
    for (const status of [401, 403, 503]) {
      const f = fixture(t, async () => new Response('<script>fixture-secret-echo</script>', { status, headers: { ...rotated, 'x-mirror-auth-status': status === 401 ? 'credential_rejected' : status === 403 ? 'owner_mismatch' : '' } }));
      await f.run(); await f.submit('fixture-secret-echo');
      assert.equal(f.rendered, undefined);
      assert.equal(f.input.value, '');
      assert.deepEqual(f.pair(), [null, null]);
      assert.equal(f.disabled(), false);
      assert.doesNotMatch(f.body(), /fixture-secret-echo/);
      assert.match(f.status(), status === 403 ? /not the allowed owner/ : status === 401 ? /Credential not accepted/ : /could not connect/);
    }
  });

  test('expired stored credentials are removed only after their own rejection and can be replaced', async t => {
    let accepted = false;
    const f = fixture(t, async () => accepted ? new Response('owner HTML', { headers: { 'content-type': 'text/html' } }) : new Response('denied', { status: 401, headers: { 'x-mirror-auth-status': 'credential_rejected' } }), ['old-access', 'old-session']);
    await f.run();
    assert.deepEqual(f.pair(), [null, null]);
    accepted = true;
    await f.submit('new-owner-credential');
    assert.deepEqual(f.pair(), ['new-owner-credential', null]);
    assert.equal(f.rendered, 'owner HTML');
  });

  test('stored access and session-only credentials retain valid refresh semantics', async t => {
    for (const initial of [['old-access'], [null, 'old-session']]) {
      const f = fixture(t, async (_url, init) => {
        assert.equal(init.headers.get('authorization'), 'Bearer ' + (initial[0] || initial[1]));
        return new Response('owner HTML', { headers: { 'content-type': 'text/html', 'x-mirror-access-token': 'fresh' } });
      }, initial);
      await f.run();
      assert.deepEqual(f.pair(), ['fresh', initial[0] || initial[1]]);
      assert.equal(f.rendered, 'owner HTML');
    }
    const f = fixture(t, async () => new Response('owner HTML', { headers: { 'content-type': 'text/html', 'x-mirror-session-token': 'fresh-session' } }), ['old-access', 'old-session']);
    await f.run();
    assert.deepEqual(f.pair(), ['old-access', 'fresh-session']);
  });

  test('credential replacement or logout during headers or body cannot render or overwrite a different identity', async t => {
    for (const phase of ['headers', 'body']) for (const change of ['replace', 'logout']) {
      const gate = deferred(), body = deferred();
      const f = fixture(t, () => gate.promise, ['old-access', 'old-session']);
      const run = f.run();
      if (phase === 'body') {
        gate.resolve({ ok: true, headers: new Headers(rotated), text: () => body.promise });
        await Promise.resolve();
      }
      f.storage.clear();
      if (change === 'replace') { f.storage.setItem('mirror_access_token', 'replacement'); f.storage.setItem('mirror_session_token', 'replacement-session'); }
      const expected = f.pair();
      if (phase === 'body') body.resolve('old HTML');
      else gate.resolve(new Response('old HTML', { headers: rotated }));
      await run;
      assert.deepEqual(f.pair(), expected);
      assert.equal(f.rendered, undefined);
      assert.match(f.status(), /Credentials changed/);
    }
  });

  test('a stale rejection does not erase replacement credentials or another pending attempt', async t => {
    const first = deferred(), second = deferred();
    let calls = 0;
    const f = fixture(t, () => (++calls === 1 ? first.promise : second.promise), ['old-access', 'old-session']);
    const old = f.run();
    const newer = f.submit('new-owner');
    first.resolve(new Response('denied', { status: 401, headers: { 'x-mirror-auth-status': 'credential_rejected' } })); await old;
    assert.equal(f.status(), 'Connecting…');
    assert.equal(f.disabled(), true);
    second.resolve(new Response('new HTML', { headers: { 'content-type': 'text/html' } })); await newer;
    assert.deepEqual(f.pair(), ['new-owner', null]);
    assert.equal(f.rendered, 'new HTML');
  });

  test('an interrupted document keeps its accepted refresh but shows a safe reconnect error', async t => {
    const f = fixture(t, async () => ({ ok: true, headers: new Headers(rotated), text: async () => { throw Error('fixture-secret-echo'); } }), ['old-access', 'old-session']);
    await f.run();
    assert.deepEqual(f.pair(), ['fixture-fresh-access', 'fixture-fresh-session']);
    assert.equal(f.rendered, undefined);
    assert.match(f.status(), /Connection interrupted/);
    assert.doesNotMatch(f.body(), /fixture-secret-echo/);
    assert.equal(f.disabled(), false);
  });

  test('network errors do not expose a candidate or persist an unverified credential', async t => {
    const f = fixture(t, async () => { throw Error('fixture-secret-echo'); });
    await f.run(); await f.submit('fixture-secret-echo');
    assert.deepEqual(f.pair(), [null, null]);
    assert.doesNotMatch(f.body(), /fixture-secret-echo/);
    assert.equal(f.disabled(), false);
  });
  test('transient errors retain stored credentials and never impersonate an owner rejection', async t => {
    for (const status of [401, 403, 429, 502, 503]) {
      const f = fixture(t, async () => new Response('untrusted error', { status, headers: rotated }), ['old-access', 'old-session']);
      await f.run();
      assert.deepEqual(f.pair(), ['old-access', 'old-session']);
      assert.match(f.status(), /could not connect/);
      assert.equal(f.rendered, undefined);
    }
  });
  test('only owner-verified document failures retain rotations, including a submitted candidate', async t => {
    for (const candidate of [false, true]) for (const verified of [false, true]) {
      const f = fixture(t, async () => new Response('unavailable', { status: verified ? 503 : 403,
        headers: { ...rotated, 'x-mirror-auth-status': verified ? 'owner_verified' : 'owner_mismatch' } }), candidate ? [] : ['old-access', 'old-session']);
      await f.run();
      if (candidate) await f.submit('candidate');
      assert.deepEqual(f.pair(), verified ? ['fixture-fresh-access', 'fixture-fresh-session'] : [null, null]);
      assert.equal(f.rendered, undefined);
    }
  });

});
