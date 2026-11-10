import assert from "node:assert/strict";
import test from "node:test";

test.describe("server / egress", () => {
  test("reports local transport mode without claiming upstream verification", async () => {
    const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
    const status = egress.getEgressStatus();
    assert.equal(status.mode, "direct");
    assert.equal(status.required, false);
    assert.equal(status.verified, false);
    assert.equal(status.checkedAt, null);
    assert.equal(status.error, null);
    // Defensive copy: mutation does not affect subsequent calls
    status.mode = "warp";
    assert.equal(egress.getEgressStatus().mode, "direct");
  });

  test("identifies the Worker runtime without asserting which binding is configured", async () => {
    const egress = await import(`../dist/egress.js?worker-egress-test=${Date.now()}`);
    const original = globalThis.WebSocketPair;
    try {
      globalThis.WebSocketPair = class {};
      const status = egress.getEgressStatus();
      assert.equal(status.mode, "worker");
      assert.equal(status.verified, false);
      assert.equal(status.checkedAt, null);
    } finally {
      if (original === undefined) delete globalThis.WebSocketPair;
      else globalThis.WebSocketPair = original;
    }
  });
});
