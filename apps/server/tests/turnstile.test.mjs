import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-turnstile-test-"));
process.env.MIRROR_DATA_DIR = dir;

const [store, auth, { ChatBody }] = await Promise.all([
  import("../dist/store.js"),
  import("../dist/auth.js"),
  import("../dist/api-schemas.js"),
]);

test.describe("server / turnstile", () => {
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("saveVerifiedSession saves and retrieves turnstileToken", () => {
  store.clearSession();
  const session = store.saveVerifiedSession(
    "acc-test",
    "dev-test",
    "turnstile-tok-abc",
  );
  assert.equal(session.turnstileToken, "turnstile-tok-abc");

  const loaded = store.getSession();
  assert.equal(loaded?.turnstileToken, "turnstile-tok-abc");
  store.clearSession();
});

test("saveVerifiedSession does not carry over turnstileToken when accountId changes", () => {
  store.clearSession();
  store.saveVerifiedSession("account-1", "device-1", "token-turnstile-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");

  // New session for a different account without turnstile token
  store.saveVerifiedSession("account-2", "device-2");
  assert.equal(store.getSession()?.accountId, "account-2");
  assert.equal(store.getSession()?.turnstileToken, undefined);
  store.clearSession();
});

test("saveVerifiedSession does not carry over turnstileToken when accountId changes", () => {
  store.clearSession();
  store.saveVerifiedSession("account-1", "device-1", "token-turnstile-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");

  // Different account
  store.saveVerifiedSession("account-2", "device-2");
  assert.equal(store.getSession()?.turnstileToken, undefined);
  store.clearSession();
});

test("saveVerifiedSession preserves turnstileToken when updating the same session and account", () => {
  store.clearSession();
  store.saveVerifiedSession("account-1", "device-1", "token-turnstile-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");

  // Same session token and account
  store.saveVerifiedSession("account-1", "device-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");
  store.clearSession();
});

test("setSessionTurnstileToken updates and clears turnstileToken in session", () => {
  store.clearSession();
  store.setSessionTurnstileToken("ignored-without-session");
  assert.equal(store.getSession(), null);
  store.saveVerifiedSession();
  assert.equal(store.getSession()?.turnstileToken, undefined);

  store.setSessionTurnstileToken("fresh-turnstile-token");
  assert.equal(store.getSession()?.turnstileToken, "fresh-turnstile-token");

  store.setSessionTurnstileToken(null);
  assert.equal(store.getSession()?.turnstileToken, undefined);
  store.clearSession();
});

test("pending session turnstile token is consumed exactly once", () => {
  store.clearSession();
  store.saveVerifiedSession("acc-test", "dev-test", "valid-cred-turnstile");
  assert.equal(store.getSession()?.turnstileToken, "valid-cred-turnstile");
  assert.equal(store.consumeSessionTurnstileToken(), "valid-cred-turnstile");
  assert.equal(store.consumeSessionTurnstileToken(), null);
  assert.equal(store.getSession()?.turnstileToken, undefined);
  store.clearSession();
});

test("a pending session turnstile token expires after five minutes", () => {
  store.clearSession();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    store.saveVerifiedSession("acc-test", "dev-test", "expiring-token");
    now += 5 * 60_000 + 1;
    assert.equal(store.consumeSessionTurnstileToken(), null);
    assert.equal(store.getSession()?.turnstileToken, undefined);
  } finally {
    Date.now = originalNow;
    store.clearSession();
  }
});

test("ChatBody rejects non-string turnstileToken", () => {
  assert.throws(() => {
    ChatBody.parse({
      prompt: "Hello",
      turnstileToken: 12345,
    });
  });
});

test("ChatBody validates optional turnstileToken", () => {
  const valid = ChatBody.parse({
    prompt: "Hello world",
    turnstileToken: "turnstile-override-123",
  });
  assert.equal(valid.turnstileToken, "turnstile-override-123");
});
});
