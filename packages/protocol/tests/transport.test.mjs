import test from "node:test";
import assert from "node:assert/strict";
import { runWithUpstreamFetch, upstreamFetch } from "../dist/transport.js";
import { mintAccessToken } from "../dist/session.js";
import { ChatGptBackendClient } from "../dist/client.js";

test.describe("request-scoped upstream routing", () => {
  test("routes session exchanges and backend calls through the supplied binding", async () => {
    const sessionToken = "session-" + "x".repeat(24000);
    const calls = [];
    await runWithUpstreamFetch(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return Response.json(calls.length === 1 ? { accessToken: "warp-access" } : { account: { account_user_id: "account-1" } });
    }, async () => {
      const minted = await mintAccessToken(sessionToken);
      const client = new ChatGptBackendClient({ accessToken: minted.accessToken, sessionToken, deviceId: "device-1" });
      await client.fetchMe();
    });
    assert.equal(calls[0].url, "https://chatgpt.com/api/auth/session");
    assert.equal(calls[0].headers.get("cookie"), `__Secure-next-auth.session-token=${sessionToken}`);
    assert.equal(calls[1].url, "https://chatgpt.com/backend-api/me");
    assert.equal(calls[1].headers.get("authorization"), "Bearer warp-access");
  });

  test("keeps concurrent transports isolated across asynchronous work", async () => {
    const route = (name) => async (input) => new Response(`${name}:${input}`);
    const results = await Promise.all(["warp-a", "warp-b"].map((name) =>
      runWithUpstreamFetch(route(name), async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return (await upstreamFetch("https://chatgpt.com/api/auth/session")).text();
      })));
    assert.deepEqual(results, ["warp-a:https://chatgpt.com/api/auth/session", "warp-b:https://chatgpt.com/api/auth/session"]);
  });

  test("does not bypass a failing network binding with ordinary egress", async () => {
    const error = new Error("Gateway rejected the connection");
    await assert.rejects(runWithUpstreamFetch(async () => { throw error; },
      () => upstreamFetch("https://chatgpt.com/backend-api/me")), (received) => received === error);
  });

  test("uses the normal Node transport outside a Worker request", async () => {
    assert.equal(await (await upstreamFetch("data:text/plain,node-transport")).text(), "node-transport");
  });
});
