import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { stubBackend } from "./helpers/backend.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-stream-lifecycle-"));
process.env.MIRROR_DATA_DIR = dir;
const store = await import("../dist/store.js");
const { registerOpenAiRoutes, remainingStreamText } = await import("../dist/openai.js");
const nativeFetch = globalThis.fetch;
test.describe("server / openai-stream-lifecycle", () => {
test.after(() => rmSync(dir, { recursive: true, force: true }));

for (const responses of [false, true]) test(`a seventh full-history ${responses ? "Responses" : "Chat"} turn sends parseable keepalives while upstream is silent, then continues the same parent`, { timeout: 5000 }, async t => {
  store.saveVerifiedSession("heartbeat-account");
  store.updateMintedToken("fixture-access", Date.now() + 3600000, null);
  const sent = [];
  const backend = stubBackend("heartbeat-account", { sent });
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let pause = false;
  globalThis.fetch = async (url, init) => {
    if (pause && String(url).endsWith("/me")) {
      entered.resolve();
      await gate.promise;
    }
    return backend(url, init);
  };
  const app = Fastify();
  await registerOpenAiRoutes(app);
  let reader;
  try {
    const history = [];
    let id;
    for (let turn = 1; turn <= 6; turn++) {
      history.push({ role: "user", content: `turn ${turn}` });
      const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { messages: history } });
      assert.equal(response.statusCode, 200, response.body);
      id ??= response.headers["x-mirror-conversation-id"];
      assert.equal(response.headers["x-mirror-conversation-id"], id);
      history.push(response.json().choices[0].message);
    }
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    pause = true;
    t.mock.timers.enable({ apis: ["setInterval"] });
    const response = await nativeFetch(`${address}/v1/${responses ? "responses" : "chat/completions"}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ [responses ? "input" : "messages"]: [...history, { role: "user", content: "seventh turn with apostrophes, (parentheses), and tool call intent" }], stream: true }),
    });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = decoder.decode((await reader.read()).value);
    await entered.promise;
    // Model the extension's data-event -> runtime.Port.postMessage path.
    // SSE comments do not reach that callback and cannot keep its worker alive.
    for (let interval = 0; interval < 4; interval++) {
      t.mock.timers.tick(10000);
      const heartbeat = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("No SSE data heartbeat during upstream preparation")), 100)),
      ]);
      const text = decoder.decode(heartbeat.value);
      const event = JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6));
      if (responses) {
        assert.equal(event.type, "response.output_text.delta");
        assert.equal(event.delta, "");
      } else {
        assert.equal(event.object, "chat.completion.chunk");
        assert.deepEqual(event.choices, [{ index: 0, delta: {}, finish_reason: null }]);
      }
      output += text;
    }
    gate.resolve();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value);
    }
    assert.match(output, /reply-7/);
    assert.match(output, responses ? /response.completed/ : /\[DONE\]/);
    assert.match(output, responses ? new RegExp(`"conversation_id":"${id}"`) : new RegExp(`mirror-conversation-id ${id}`));
    const lastTurn = sent.filter(item => item.pathname.endsWith("/f/conversation")).at(-1).body;
    assert.equal(lastTurn.parent_message_id, "assistant-6");
    assert.equal(lastTurn.conversation_id, "upstream-1");
    assert.equal(store.listMessages(id).length, 14);
    assert.equal(store.listMessages(id).at(-1).content, "reply-7");
    // A finished request must not leave a timer writing into the closed socket.
    t.mock.timers.tick(30000);
  } finally {
    gate.resolve();
    await reader?.cancel();
    t.mock.timers.reset();
    globalThis.fetch = nativeFetch;
    await app.close();
  }
});

for (const failure of ["idle deadline", "heartbeat write"]) {
  test(`silent streams terminate on ${failure} and release the conversation for retry`, { timeout: 5000 }, async t => {
    const account = `heartbeat-${failure}`;
    store.saveVerifiedSession("hé🙂"), " complete");
  assert.equal(remainingStreamText("same", "same"), "");
  assert.equal(remainingStreamText("first answer", ""), "first answer");
  for (const replacement of ["different answer", "already", ""]) {
    assert.throws(() => remainingStreamText(replacement, "already delivered"), /changed text already delivered/);
  }
});
});
