globalThis.WebSocketPair = class {};

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


import { resolveImageAttachment } from "../dist/conversation-context.js";

test.describe("server / conversation-context image DNS edges", () => {
  test("rejects a private literal IP host", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("image", { headers: { "content-type": "image/png" } });
    try {
      await assert.rejects(
        resolveImageAttachment({ uploadFile: async () => ({ fileId: "x" }) }, { type: "image_url", image_url: { url: "https://127.0.0.1/image" } }, 0),
        /host is not permitted/
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("filters falsy DNS answer data", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") {
        return Response.json({ Answer: [{ data: "" }, { data: "8.8.8.8" }] });
      }
      return new Response("image", { headers: { "content-type": "image/png" } });
    };
    try {
      const result = await resolveImageAttachment(
        { uploadFile: async () => ({ fileId: "ok" }) },
        { type: "image_url", image_url: { url: "https://public.example/image" } },
        0
      );
      assert.equal(result.fileId, "ok");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("cancels redirect body when present and skips when absent", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") {
        return Response.json({ Answer: [{ data: "8.8.8.8" }] });
      }
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: "https://public.example/final" } });
      }
      return new Response("image-data", { headers: { "content-type": "image/png" } });
    };
    try {
      const result = await resolveImageAttachment(
        { uploadFile: async () => ({ fileId: "redirected" }) },
        { type: "image_url", image_url: { url: "https://public.example/start" } },
        0
      );
      assert.equal(result.fileId, "redirected");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("accepts a public literal IP host", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("image", { headers: { "content-type": "image/png" } });
    try {
      const result = await resolveImageAttachment(
        { uploadFile: async () => ({ fileId: "public-ip" }) },
        { type: "image_url", image_url: { url: "https://8.8.8.8/image" } },
        0
      );
      assert.equal(result.fileId, "public-ip");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("cancels a redirect body when the response has one", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") {
        return Response.json({ Answer: [{ data: "8.8.8.8" }] });
      }
      calls++;
      if (calls === 1) {
        return new Response("redirect-body", { status: 302, headers: { location: "https://public.example/final" } });
      }
      return new Response("final-image", { headers: { "content-type": "image/png" } });
    };
    try {
      const result = await resolveImageAttachment(
        { uploadFile: async () => ({ fileId: "with-body" }) },
        { type: "image_url", image_url: { url: "https://public.example/start" } },
        0
      );
      assert.equal(result.fileId, "with-body");
    } finally {
      globalThis.fetch = original;
    }
  });
});
