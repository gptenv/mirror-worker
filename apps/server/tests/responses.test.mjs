import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stubBackend } from "./helpers/backend.mjs";
const dir = mkdtempSync(path.join(tmpdir(), "mirror-responses-"));
process.env.MIRROR_DATA_DIR = dir;
delete process.env.MIRROR_STORE_KEY;
process.env.MIRROR_API_KEY = 'synthetic-access-fixture';
const { default: Fastify } = await import("fastify");
const store = await import("../dist/store.js");
const { registerOpenAiRoutes } = await import("../dist/openai.js");
const { ResponsesBody, responsesToCompletion } = await import("../dist/responses.js");
const app = Fastify();
await registerOpenAiRoutes(app);
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const localFetch = globalThis.fetch;
test.describe("server / responses", () => {
test("Responses stream by default and honors explicit opt-out", () => {
  assert.equal(ResponsesBody.parse({ input: "Hello" }).stream, true);
  assert.equal(ResponsesBody.parse({ input: "Hello", stream: false }).stream, false);
});
test("Responses image and file input maps to the existing attachment pipeline", () => {
  const mapped = responsesToCompletion(ResponsesBody.parse({ input: [{ role: "user", content: [
    { type: "input_text", text: "Read " },
    { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
    { type: "input_text", text: "these" },
    { type: "input_file", file_data: "data:application/pdf;base64,JVBERi0=", filename: "report.pdf" },
  ] }] }));
  assert.deepEqual(mapped.messages[0].content, [
    { type: "text", text: "Read these" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
    { type: "file", file: { file_data: "data:application/pdf;base64,JVBERi0=", filename: "report.pdf" } },
  ]);
  assert.throws(() => responsesToCompletion(ResponsesBody.parse({ input: [{ role: "user", content: [{ type: "input_image", file_id: "file_123" }] }] })), /file_id is unsupported/);
  assert.throws(() => responsesToCompletion(ResponsesBody.parse({ input: [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }] })), /file_id is unsupported/);
  assert.throws(() => responsesToCompletion(ResponsesBody.parse({ input: [
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "latest question" },
  ] })), /final user message/);
  assert.throws(() => responsesToCompletion(ResponsesBody.parse({ input: [
    { role: "user", content: "latest question" },
    { role: "assistant", content: [{ type: "input_file", file_data: "data:text/plain;base64,SGk=" }] },
  ] })), /final user message/);
  const noPathFilename = responsesToCompletion(ResponsesBody.parse({ input: [{ role: "user", content: [
    { type: "input_file", file_url: "https://example.com/" },
  ] }] }));
  assert.deepEqual(noPathFilename.messages[0].content, [
    { type: "file", file: { file_data: "https://example.com/" } },
  ]);
});
test.after(async () => { globalThis.fetch = localFetch; await app.close(); rmSync(dir, { recursive: true, force: true }); });
function setup(account, options = {}) {
  store.saveVerifiedSession(account, "synthetic-device");
  globalThis.fetch = stubBackend(account, options);
}
function setupWithUploads(account, { sent = [], uploads = [], sourceFails = false } = {}) {
  store.saveVerifiedSession(account, "synthetic-device");
  const backend = stubBackend(account, { sent });
  let uploaded = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const pathname = parsedUrl.pathname;
    if (parsedUrl.hostname === "images.example") return new Response(Buffer.from([1, 2, 3]), { headers: { "content-type": "image/png" } });
    if (parsedUrl.hostname === "files.example") return sourceFails
      ? new Response("synthetic file source failure", { status: 503 })
      : new Response(Buffer.from("%PDF-test"), { headers: { "content-type": "application/pdf" } });
    if (pathname === "/backend-api/files" && init.method === "POST") {
      sent.push({ pathname, body: JSON.parse(init.body) });
      const fileId = `response-file-${++uploaded}`;
      return Response.json({ upload_url: `https://blob.example/${fileId}`, file_id: fileId });
    }
    if (/^\/response-file-\d+$/.test(pathname)) {
      uploads.push({ data: Buffer.from(init.body), mimeType: init.headers["content-type"] });
      return new Response(null, { status: 200 });
    }
    if (/^\/backend-api\/files\/response-file-\d+\/uploaded$/.test(pathname)) return Response.json({ status: "success" });
    return backend(url, init);
  };
  return { sent, uploads };
}
async function post(body) {
  return localFetch(`${address}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: false, ...body }) });
}
test("Responses uploads documented image and file inputs and forwards both attachments", async () => {
  const { sent, uploads } = setupWithUploads("multimodal-upload");
  const res = await post({ input: [{ role: "user", content: [
    { type: "input_text", text: "Describe these." },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    { type: "input_file", file_data: "data:application/pdf;base64,JVBERi0=", filename: "report.pdf" },
  ] }] });
  assert.equal(res.status, 200, await res.clone().text());
  const creates = sent.filter(call => call.pathname === "/backend-api/files");
  assert.deepEqual(creates.map(call => [call.body.file_name, call.body.use_case]), [
    ["image-0.png", "multimodal"], ["report.pdf", "my_files"],
  ]);
  assert.deepEqual(uploads.map(upload => upload.mimeType), ["image/png", "application/pdf"]);
  const turn = sent.find(call => call.pathname.endsWith("/f/conversation"));
  assert.deepEqual(turn.body.messages[0].metadata.attachments.map(file => [file.name, file.mimeType]), [
    ["image-0.png", "image/png"], ["report.pdf", "application/pdf"],
  ]);
});
test("Responses accepts detail fields and uploads URL image and PDF file with filename inferred from URL", async () => {
  const { sent, uploads } = setupWithUploads("multimodal-url-upload");
  const res = await post({ stream: true, input: [{ role: "user", content: [
    { type: "input_text", text: "Read and describe." },
    { type: "input_image", image_url: "https://images.example/cat.png", detail: "original" },
    { type: "input_file", file_url: "https://files.example/docs/report.pdf", detail: "high" },
  ] }] });
  const wire = await res.text();
  assert.equal(res.status, 200, wire);
  const events = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, "response.created");
  assert.equal(events.at(-1).type, "response.completed");
  assert.deepEqual(sent.filter(call => call.pathname === "/backend-api/files").map(call => [call.body.file_name, call.body.use_case]), [
    ["image-0.png", "multimodal"], ["report.pdf", "my_files"],
  ]);
  assert.deepEqual(uploads.map(upload => upload.mimeType), ["image/png", "application/pdf"]);
});
test("Responses file IDs and attachments outside the final user message return 400 before upstream access", async () => {
  setup("invalid-multimodal");
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; throw new Error("Must not call upstream"); };
  for (const input of [
    [{ role: "user", content: [{ type: "input_image", file_id: "file_123" }] }],
    [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
    [{ role: "user", content: [{ type: "input_file", file_id: "file_123", file_url: "https://files.example/report.pdf" }] }],
    [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { role: "assistant", content: "Earlier response" },
      { role: "user", content: "Current question" },
    ],
  ]) {
    const res = await post({ input, stream: true });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.type, "invalid_request_error");
    assert.notEqual(body.type, "response");
  }
  assert.equal(upstreamCalls, 0);
});
test("failed streamed attachment resolution returns a client error without a completed response event", async () => {
  setupWithUploads("multimodal-url-failure", { sourceFails: true });
  for (const fileUrl of ["https://files.example/docs/report.pdf", "not an absolute URL"]) {
    const res = await post({ stream: true, input: [{ role: "user", content: [
      { type: "input_file", file_url: fileUrl },
    ] }] });
    const body = await res.text();
    assert.equal(res.status, 400, body);
    assert.match(body, /invalid_request_error/);
    assert.doesNotMatch(body, /response\.completed/);
  }
});
for (const minimal of [true, false]) test(`Responses three turns, mixed transport, minimal=${minimal}`, async () => {
  const sent = []; setup(`responses-${minimal}`, { sent });
  let id;
  const input = [];
  for (let turn = 1; turn <= 3; turn++) {
    input.push({ role: "user", content: `Question ${turn}` });
    const stream = turn !== 2;
    const requestStartedAt = Math.floor(Date.now() / 1000);
    const res = await post({ model: "auto", input: minimal ? `Question ${turn}` : input, stream, max_output_tokens: 1,
      ...(id ? { metadata: { conversation_id: id } } : {}) });
    assert.equal(res.status, 200);
    let body;
    if (stream) {
      const wire = await res.text();
      assert.ok(!wire.includes("chat.completion"));
      const events = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.equal(events[0].type, "response.created");
      assert.equal("completed_at" in events[0].response, false);
      assert.equal(events.at(-1).type, "response.completed");
      assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
      body = events.at(-1).response;
      assert.equal(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join(""), body.output[0].content[0].text);
      assert.ok(wire.includes("event: response.completed\n"));
    } else body = await res.json();
    const requestFinishedAt = Math.floor(Date.now() / 1000);
    assert.equal(body.object, "response"); assert.equal(body.status, "completed");
    assert.ok(Number.isInteger(body.completed_at));
    assert.ok(body.completed_at >= requestStartedAt && body.completed_at <= requestFinishedAt,
      `completed_at ${body.completed_at} should be within ${requestStartedAt}..${requestFinishedAt} Unix seconds`);
    assert.match(body.id, /^resp_/); assert.equal(body.usage, null);
    id ??= body.metadata.conversation_id;
    assert.equal(body.metadata.conversation_id, id);
    assert.equal(body.output[0].content[0].text, `reply-${turn}`);
    input.push(body.output[0]);
    assert.equal(store.countConversations(`responses-${minimal}`), 1);
    assert.equal(store.listMessages(id).at(-1).content, `reply-${turn}`);
    const requests = sent.filter(item => item.pathname.endsWith("/f/conversation"));
    assert.equal(requests.at(-1).body.parent_message_id, turn === 1 ? "client-created-root" : `assistant-${turn - 1}`);
  }
});
test("one-shot, instructions and input_text", async () => {
  setup("one-shot");
  const res = await post({ input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }], instructions: "Be helpful", store: false, metadata: { conversation_id: "ignored" } });
  const body = await res.json(); assert.equal(body.status, "completed");
  assert.equal(body.instructions, "Be helpful"); assert.equal(body.metadata.conversation_id, undefined);
  assert.equal(res.headers.get("x-mirror-conversation-id"), null);
  assert.equal(store.countConversations("one-shot"), 0);
});
test("unsupported features fail before upstream access", async () => {
  setup("invalid"); globalThis.fetch = async () => { throw new Error("Must not call upstream"); };
  for (const extra of [{ tools: [] }, { previous_response_id: "resp_123" }, { background: true }, { input: "" }, { input: [{ role: "user", content: [{ type: "input_audio", audio: "x" }] }] }]) {
    const res = await post({ input: "Hello", ...extra }); assert.equal(res.status, 400); assert.ok((await res.json()).error);
  }
});
test("upstream errors produce response.failed without successful completion", async () => {
  setup("failure"); globalThis.fetch = async () => { throw new Error("Synthetic upstream failure"); };
  const res = await post({ input: "Hello", stream: true });
  const wire = await res.text(); assert.ok(wire.includes("event: response.failed")); assert.ok(!wire.includes("event: response.completed"));
  const failed = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).at(-1);
  assert.equal(failed.type, "response.failed"); assert.equal("completed_at" in failed.response, false);
});
test("Chat and Responses share history and reject assistant edits", async () => {
  const sent = []; setup("cross-mode", { sent });
  const first = await (await post({ input: "First question" })).json();
  const id = first.metadata.conversation_id;
  const chat = await localFetch(`${address}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: false, messages: [{role:"user",content:"Second question"}], metadata:{conversation_id:id} }) });
  assert.equal(chat.status, 200); const second = await chat.json();
  assert.equal(second.choices[0].message.content, "reply-2");
  const requestCount = sent.length;
  const edited = await post({ input:[{role:"user",content:"First question"},{role:"assistant",content:"Edited"},{role:"user",content:"Third question"}], metadata:{conversation_id:id} });
  assert.equal(edited.status,400); assert.equal(sent.length,requestCount);
  const third = await (await post({input:"Third question",metadata:{conversation_id:id}})).json();
  assert.equal(third.output[0].content[0].text,"reply-3"); assert.equal(third.metadata.conversation_id,id);
  assert.equal(store.countConversations("cross-mode"),1);
});
});
