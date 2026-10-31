import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-auth-"));
process.env.MIRROR_DATA_DIR = dir;
const auth = await import("../dist/auth.js");

test.describe("server / auth", () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test("anonymous scopes cannot inherit enclosing credentials or rotation", async () => {
    await auth.runWithRequestSessionToken("owner", async () => {
      const credentials = await auth.getValidCredentials();
      credentials.accessToken = "owner-rotated";
      credentials.rotatedSessionToken = "owner-session-rotated";
      await auth.runWithRequestSessionToken(undefined, async () => {
        assert.equal(auth.getRequestSessionToken(), "");
        assert.equal(auth.getRequestFallbackSessionToken(), undefined);
        await assert.rejects(auth.getValidCredentials(), { statusCode: 401 });
        assert.equal(await auth.getRotatedRequestAccessToken(), undefined);
        assert.equal(await auth.getRotatedRequestSessionToken(), undefined);
      });
      assert.equal(auth.getRequestSessionToken(), "owner");
      assert.equal(await auth.getRotatedRequestAccessToken(), "owner-rotated");
    }, "owner-session", ["owner"]);
  });

  test("overlapping scopes retain their own bearer, fallback and rotation", async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const owner = auth.runWithRequestSessionToken("owner", async () => {
      const credentials = await auth.getValidCredentials();
      started.resolve();
      await release.promise;
      assert.equal(auth.getRequestSessionToken(), "owner");
      assert.equal(auth.getRequestFallbackSessionToken(), "owner-session");
      assert.equal(credentials.accessToken, "owner");
      assert.equal(await auth.getRotatedRequestAccessToken(), undefined);
    }, "owner-session");
    await started.promise;
    try {
      await auth.runWithRequestSessionToken("other", async () => {
        const credentials = await auth.getValidCredentials();
        credentials.accessToken = "other-rotated";
        credentials.rotatedSessionToken = "other-session-rotated";
        await Promise.resolve();
        assert.equal(auth.getRequestFallbackSessionToken(), "other-session");
        assert.equal(await auth.getRotatedRequestAccessToken(), "other-rotated");
        assert.equal(await auth.getRotatedRequestSessionToken(), "other-session-rotated");
      }, "other-session");
    } finally { release.resolve(); }
    await owner;
  });

  test("configured keys select the configured account while unrelated bearers stay independent", async () => {
    await auth.runWithRequestSessionToken(undefined, async () => {
      assert.equal((await auth.getValidCredentials()).accessToken, "configured");
    }, undefined, ["configured"]);
    await auth.runWithRequestSessionToken("other", async () => {
      assert.equal((await auth.getValidCredentials()).accessToken, "other");
      assert.equal(auth.getRequestFallbackSessionToken(), "fallback");
    }, "fallback", ["configured"]);
  });
  test("failed session exchange records only token lengths", async t => {
    t.mock.method(globalThis, "fetch", async input => new URL(String(input)).pathname === "/api/auth/session"
      ? new Response('{"error":"invalid token"}', { status: 403, headers: { "content-type": "application/json" } })
      : new Response("unauthorized", { status: 401 }));
    await auth.runWithRequestSessionToken("old-access", async () => {
      const credentials = await auth.getValidCredentials();
      await assert.rejects(auth.fetchWithAccessTokenFallback('https://chatgpt.com/backend-api/me', { headers: { cookie: 'other=value; __Secure-next-auth.session-token=stale' } }, credentials), error => {
        assert.equal(error.statusCode, 401);
        assert.equal(error.tokenLengths.accessToken.received, 10);
        assert.equal(error.tokenLengths.sessionToken.received, 10);
        return true;
      });
    });
  });
  test("a rotated session replaces only its cookie and is returned to the caller", async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      if (new URL(String(input)).pathname === '/api/auth/session')
        return Response.json({ accessToken: 'fresh-access' }, { headers: { 'set-cookie': '__Secure-next-auth.session-token=rotated; Path=/' } });
      calls++;
      const cookie = new Headers(init.headers).get('cookie');
      if (calls === 1) {
        assert.equal(cookie, 'other=value; __Secure-next-auth.session-token=old-session');
        return new Response('unauthorized', { status: 401 });
      }
      assert.equal(cookie, 'other=value; __Secure-next-auth.session-token=rotated');
      return Response.json({ ok: true });
    });
    await auth.runWithRequestSessionToken('old-access', async () => {
      const credentials = await auth.getValidCredentials();
      const response = await auth.fetchWithAccessTokenFallback('https://chatgpt.com/backend-api/me', { headers: { cookie: 'other=value; __Secure-next-auth.session-token=stale' } }, credentials);
      assert.equal(response.status, 200);
      assert.equal(await auth.getRotatedRequestSessionToken(), 'rotated');
    }, 'old-session');
  });
  for (const mode of ["unavailable", "invalid", "transport"]) test(`failed ${mode} session exchange releases the denied response without replacing its error`, async t => {
    let cancelled = 0;
    let cancelledBeforeExchange = false;
    const upstreamBody = JSON.stringify({ error: mode === "invalid" ? "invalid token" : "fixture exchange unavailable" });
    const transportError = new Error("fixture exchange transport failed");
    t.mock.method(globalThis, "fetch", async input => {
      if (new URL(String(input)).pathname === "/api/auth/session") {
        cancelledBeforeExchange = cancelled === 1;
        if (mode === "transport") throw transportError;
        return new Response(upstreamBody, { status: mode === "invalid" ? 401 : 503, headers: { "content-type": "application/json" } });
      }
      return new Response(new ReadableStream({
        cancel() {
          cancelled++;
          // A failed cleanup must not replace the useful upstream diagnostic.
          if (mode === "unavailable") throw new Error("fixture cancellation failed");
        },
      }), { status: 401 });
    });
    await auth.runWithRequestSessionToken("fixture-expired", async () => {
      const credentials = await auth.getValidCredentials();
      await assert.rejects(auth.fetchWithAccessTokenFallback("https://chatgpt.com/backend-api/me", {}, credentials), error => {
        if (mode === "transport") assert.equal(error, transportError);
        else {
          assert.equal(error.statusCode, mode === "invalid" ? 401 : 503);
          assert.equal(error.upstreamResponseText, upstreamBody);
        }
        assert.equal(error.tokenLengths.accessToken.received, "fixture-expired".length);
        assert.equal(error.tokenLengths.sessionToken.received, `fixture-session-${mode}`.length);
        return true;
      });
      assert.equal(cancelled, 1);
      assert.equal(cancelledBeforeExchange, true);
      assert.equal(await auth.getRotatedRequestAccessToken(), undefined);
      assert.equal(await auth.getRotatedRequestSessionToken(), undefined);
    }, `fixture-session-${mode}`, []);
  });
  test("session exchange works when a caller supplied no initial cookie", async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async input => {
      if (new URL(String(input)).pathname === '/api/auth/session') return Response.json({ accessToken: 'fresh' });
      return ++calls === 1 ? new Response('unauthorized', { status: 401 }) : Response.json({ ok: true });
    });
    const credentials = { accessToken: 'old', sessionToken: 'session', deviceId: 'device' };
    assert.equal((await auth.fetchWithAccessTokenFallback('https://chatgpt.com/backend-api/me', {}, credentials)).status, 200);
  });

  test("uses the browser bearer as accessToken and keeps the saved sessionToken as fallback", async () => {
    await auth.runWithRequestSessionToken("access-from-browser", async () => {
      auth.setRequestSessionToken("access-from-browser", "session-from-browser");
      const credentials = await auth.getValidCredentials();
      assert.equal(credentials.accessToken, "access-from-browser");
      assert.equal(credentials.sessionToken, "session-from-browser");
      assert.equal(await auth.getRotatedRequestAccessToken(), undefined);
    });
  });

  test("requires a browser bearer and does not read or mint server-side credentials", async () => {
    await auth.runWithRequestSessionToken(undefined, async () => {
      await assert.rejects(auth.getValidCredentials(), error => {
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /accessToken or sessionToken as a Bearer/);
        return true;
      });
    });
  });

  test("returns a newly minted value only after the request credentials have changed", async () => {
    await auth.runWithRequestSessionToken("old-access", async () => {
      const credentials = await auth.getValidCredentials();
      credentials.accessToken = "new-access";
      assert.equal(await auth.getRotatedRequestAccessToken(), "new-access");
    });
  });

  test("tries the bearer first, then exchanges the client-held session token after 401", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const authorization = new Headers(init.headers).get("authorization");
      calls.push([url.pathname, authorization]);
      if (url.pathname === "/backend-api/me") {
        return authorization === "Bearer access-from-browser"
          ? new Response("unauthorized", { status: 401 })
          : Response.json({ id: "user-1" });
      }
      if (url.pathname === "/api/auth/session") {
        assert.match(new Headers(init.headers).get("cookie"), /session-from-browser/);
        return Response.json({ accessToken: "minted-access" });
      }
      throw new Error(`Unexpected request: ${url.href}`);
    };
    try {
      await auth.runWithRequestSessionToken("access-from-browser", async () => {
        auth.setRequestSessionToken("access-from-browser", "session-from-browser");
        const credentials = await auth.getValidCredentials();
        const response = await auth.fetchWithAccessTokenFallback("https://chatgpt.com/backend-api/me", {
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        }, credentials);
        assert.equal(response.status, 200);
        assert.equal(credentials.accessToken, "minted-access");
        assert.equal(await auth.getRotatedRequestAccessToken(), "minted-access");
      });
      assert.deepEqual(calls, [
        ["/backend-api/me", "Bearer access-from-browser"],
        ["/api/auth/session", null],
        ["/backend-api/me", "Bearer minted-access"],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
