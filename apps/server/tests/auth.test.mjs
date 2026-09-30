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
