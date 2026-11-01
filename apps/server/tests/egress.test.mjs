import assert from "node:assert/strict";
import test from "node:test";

test.describe("server / egress", () => {
  test("getEgressStatus reports direct mode that is not required and is verified", async () => {
    const egress = await import(`../dist/egress.js?egress-test=${Date.now()}`);
    const status = egress.getEgressStatus();
    assert.equal(status.mode, "direct");
    assert.equal(status.required, false);
    assert.equal(status.verified, true);
    assert.equal(status.error, null);
    assert.ok(typeof status.checkedAt === "string" && status.checkedAt.length > 0);
    // Defensive copy: mutation does not affect subsequent calls
    status.mode = "warp";
    assert.equal(egress.getEgressStatus().mode, "direct");
  });
});
