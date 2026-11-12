
import test from "node:test";
import assert from "node:assert/strict";
import { promptFor, currentTurn } from "../dist/conversation-context.js";

test.describe("server / conversation-context edge cases", () => {
  test("promptFor returns empty string when there is no current turn", () => {
    assert.equal(promptFor([]), "");
  });
  test("currentTurn returns undefined for empty array", () => {
    assert.equal(currentTurn([]), undefined);
  });
});

