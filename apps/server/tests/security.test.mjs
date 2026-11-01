import assert from "node:assert/strict";
import test from "node:test";
import {
  mayBootstrapBrowser,
  bearerToken,
  configuredApiKeys,
  isAllowedOrigin,
  isAllowedRequestHost,
  isLoopbackHostname,
  tokenMatches,
} from "../dist/security.js";

test.describe("server / security", () => {
test("combines singular and plural API-key settings without empty-value precedence", () => {
  assert.deepEqual(
    configuredApiKeys({ MIRROR_API_KEY: "one", MIRROR_API_KEYS: "two, three" }),
    ["one", "two", "three"],
  );
  assert.deepEqual(
    configuredApiKeys({ MIRROR_API_KEY: "one", MIRROR_API_KEYS: "" }),
    ["one"],
  );
});

test("accepts loopback hosts and rejects DNS-rebinding hostnames", () => {
  assert.equal(isLoopbackHostname("127.0.0.8"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isAllowedRequestHost("localhost:8799"), true);
  assert.equal(isAllowedRequestHost("127.0.0.1:8799"), true);
  assert.equal(isAllowedRequestHost("attacker.example:8799"), false);
  assert.equal(isAllowedRequestHost(undefined), false);
});

test("MIRROR_ALLOWED_HOSTS is a demo-only escape hatch for one extra hostname", () => {
  const env = { MIRROR_ALLOWED_HOSTS: "demo.ngrok.example, Other.Example" };
  assert.equal(isAllowedRequestHost("demo.ngrok.example:443", env), true);
  assert.equal(isAllowedRequestHost("other.example:443", env), true);
  assert.equal(isAllowedRequestHost("unlisted.example:443", env), false);
  assert.equal(isAllowedRequestHost("unlisted.example:443", {}), false);
});

test("an unparseable Host header is rejected rather than throwing", () => {
  // hostnameFromHost() wraps this as `http://${host}` internally, so an
  // unterminated IPv6 literal here reliably fails URL parsing.
  assert.equal(isAllowedRequestHost("[::1"), false);
});

test("allows same-origin and configured development origins only", () => {
  assert.equal(
    isAllowedOrigin("http://127.0.0.1:8799", "127.0.0.1:8799"),
    true,
  );
  assert.equal(
    isAllowedOrigin("https://attacker.example", "127.0.0.1:8799"),
    false,
  );
  assert.equal(isAllowedOrigin(undefined, "127.0.0.1:8799"), true);
});

test("an unparseable Origin header is rejected rather than throwing", () => {
  assert.equal(isAllowedOrigin("http://[::1", "127.0.0.1:8799"), false);
});

test("with no request host to compare against, only the configured development origin is allowed", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173", undefined), true);
  assert.equal(isAllowedOrigin("https://attacker.example", undefined), false);
});

test("parses and compares bearer credentials", () => {
  assert.equal(bearerToken("Bearer secret"), "secret");
  assert.equal(tokenMatches("secret", ["other", "secret"]), true);
  assert.equal(tokenMatches("wrong", ["secret"]), false);
});


test("OPENAI_API_KEY works alone and alongside Mirror keys while ignoring blanks", () => {
  assert.deepEqual(configuredApiKeys({ OPENAI_API_KEY: " compat " }), ["compat"]);
  assert.deepEqual(configuredApiKeys({ MIRROR_API_KEY: "", MIRROR_API_KEYS: " , ", OPENAI_API_KEY: "compat" }), ["compat"]);
  assert.deepEqual(configuredApiKeys({ MIRROR_API_KEY: "mirror", MIRROR_API_KEYS: "second", OPENAI_API_KEY: "compat" }), ["mirror", "second", "compat"]);
  assert.deepEqual(configuredApiKeys({ OPENAI_API_KEY: "   " }), []);
});
test("Worker document intent supports Android and legacy navigation while excluding data and resources", () => {
  const android = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  for (const headers of [android, { ...android, 'sec-fetch-site': 'none' }, { ...android, 'sec-fetch-site': 'same-origin' }, { ...android, accept: '*/*' }, { accept: android.accept }, { accept: android.accept, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal(mayBootstrapBrowser('GET', '/space/files?q=1', headers, true), true);
  }
  for (const url of ['/api', '/backend-api', '/__codex-api/me', '/ces/x', '/sentinel/x', '/realtime/x', '/cdn/a', '/_next/data/x', '/assets/x', '/mirror/assets/x', '/unauth-mweb/assets/a', '/unauth-mweb/scripts/a', '/index.html', '/mirror/inject.js', '/favicon.ico', '/robots.txt', '/manifest.webmanifest', '/space.data', '/space?_rsc=x', '/space?_data=x', '/%61pi/session', '/space/../api/session', '/%2fapi/session', '/space%5capi', '/space%00', '/space%zz', 'https://outside.example/', '//outside.example/']) {
    assert.equal(mayBootstrapBrowser('GET', url, android, true), false, url);
  }
  for (const headers of [{}, { accept: 'application/json' }, { ...android, rsc: '1' }, { ...android, accept: 'text/x-component' }, { ...android, 'sec-fetch-mode': 'cors' }, { ...android, 'sec-fetch-dest': 'iframe' }, { accept: 'text/html', 'sec-fetch-mode': 'navigate' }, { accept: 'text/html', 'sec-fetch-dest': 'document' }]) {
    assert.equal(mayBootstrapBrowser('GET', '/space/', headers, true), false);
  }
  assert.equal(mayBootstrapBrowser('GET', '/space/', { accept: 'text/html' }), false, 'Node cookie scope is unchanged');
});

test("only public document shells allow external top-level navigation", () => {
  const headers = { accept: 'text/html', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  for (const url of ['/', '/mirror/playground', '/mirror/api-docs', '/c/fixture-thread', '/c/fixture-thread/?q=1', '/g/g-fixture', '/g/g-fixture/c/fixture-thread', '/g/g-p-fixture/project', '/space/', '/space/files', '/space/d/external-gdrive%3Aaccount%3Afixture%3Aroot', '/mirror/openapi?format=yaml', '/future-ui/nested/encoded%20slug']) {
    assert.equal(mayBootstrapBrowser('GET', url, headers, true), true);
    assert.equal(mayBootstrapBrowser('GET', url, headers), false, 'cross-site navigation cannot mint a Node control cookie');
    assert.equal(mayBootstrapBrowser('GET', url, { ...headers, 'sec-fetch-mode': 'cors' }, true), false);
    assert.equal(mayBootstrapBrowser('GET', url, { ...headers, 'sec-fetch-dest': 'iframe' }, true), false);
    assert.equal(mayBootstrapBrowser('POST', url, headers, true), false);
  }
  for (const url of ['/api/conversations', '/backend-api/conversation/fixture', '/v1/models', '//evil.example/c/id', '/c/../api/session', '/g/g-fixture/../../api/session', '/g/g-fixture/c/https://evil.example']) {
    assert.equal(mayBootstrapBrowser('GET', url, headers, true), false);
  }
});

});
