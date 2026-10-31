import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-startup-"));
process.env.MIRROR_DATA_DIR = dir;
const { default: Fastify } = await import("fastify");
let app, listenOptions;
let failListenOnce = false;
mock.module("fastify", { defaultExport: options => {
  app = Fastify(options);
  const listen = app.listen.bind(app);
  app.listen = async options => {
    listenOptions = options;
    if (failListenOnce) {
      failListenOnce = false;
      throw Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787"), { code: "EADDRINUSE" });
    }
    // Always bind a private ephemeral test port, including for the defaults case.
    return listen({ port: 0, host: "127.0.0.1" });
  };
  return app;
} });
test.describe("server / startup", () => {
test.after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

test("a failed bind (e.g. the port is already in use) is classified and exits 1 instead of crashing raw", async t => {
  const originalArgv = process.argv;
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  failListenOnce = true;
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  t.mock.method(process, "exit", code => { exit(code); });
  let logged = "";
  t.mock.method(console, "error", (...args) => { logged = args.join(" "); });
  try {
    process.argv = [process.execPath, fileURLToPath(new URL("../dist/index.js", import.meta.url))];
    await import(`../dist/index.js?startup=failListen`);
    assert.equal(await exited, 1);
    assert.match(logged, /^mirror failed to start \[port-in-use\]: listen EADDRINUSE/);
    assert.match(logged, /Next step: Another process is already using this port/);
  } finally {
    process.argv = originalArgv;
  }
});

test("executable startup applies default and explicit listener settings", async () => {
  const originalArgv = process.argv;
  const originalPort = process.env.PORT;
  const originalHost = process.env.HOST;
  try {
    process.argv = [process.execPath, fileURLToPath(new URL("../dist/index.js", import.meta.url))];
    for (const explicit of [false, true]) {
      if (explicit) { process.env.PORT = "0"; process.env.HOST = "127.0.0.1"; }
      else { delete process.env.PORT; delete process.env.HOST; }
      await import(`../dist/index.js?startup=${explicit}`);
      assert.deepEqual(listenOptions, { port: explicit ? 0 : 8787, host: "127.0.0.1" });
      assert.equal(app.server.listening, true);
      const health = await app.inject({ url: "/api/health", headers: { host: "localhost" } });
      assert.equal(health.statusCode, 200);
      await app.close();
    }
  } finally {
    process.argv = originalArgv;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
    if (originalHost === undefined) delete process.env.HOST; else process.env.HOST = originalHost;
  }
});
});
