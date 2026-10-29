import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';

test.describe('server / worker websocket', () => {
  test('the Worker rejects websocket upgrades in the actual local runtime', { timeout: 30000 }, async () => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const dir = mkdtempSync(path.join(tmpdir(), 'mirror-worker-ws-'));
    const child = spawn(path.resolve('node_modules/.bin/wrangler'), ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', dir, '--var', `MIRROR_STORE_KEY:${'a'.repeat(64)}`, '--var', 'MIRROR_OWNER_ACCOUNT_ID:fixture-owner'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    try {
      const deadline = Date.now() + 20000;
      while (!output.includes('Ready on')) {
        if (child.exitCode !== null) throw new Error(`Worker exited before startup: ${output}`);
        if (Date.now() > deadline) throw new Error(`Worker did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const result = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path: '/backend-api/celsius/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'MDEyMzQ1Njc4OWFiY2RlZg==' } }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('Worker unexpectedly accepted the websocket')); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(result.status, 501);
      assert.match(result.body, /WebSocket proxying is disabled/);
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
