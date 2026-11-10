import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test.describe('worker / native Durable Object migration recovery', { timeout: 120_000 }, () => {
  let directory;
  let runtime;
  let options;
  test.before(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'mirror-schema-workerd-'));
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: path.join(directory, 'config') };
    for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_API_|MIRROR_|OPENAI_API_KEY)/.test(key)) delete env[key];
    const production = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    const config = path.join(directory, 'wrangler.json');
    writeFileSync(config, JSON.stringify({
      name: 'mirror-schema-acceptance', main: path.resolve('tests/worker/fixtures/schema-probe.ts'),
      compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags,
      durable_objects: { bindings: [{ name: 'PROBE', class_name: 'SchemaProbe' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['SchemaProbe'] }],
    }));
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', config, '--dry-run', '--outdir', path.join(directory, 'bundle')], { env, stdio: 'pipe', timeout: 60_000 });
    options = convertV4MiniflareOptions({
      name: 'mirror-schema-acceptance', host: '127.0.0.1', modules: true,
      scriptPath: path.join(directory, 'bundle/schema-probe.js'), modulesRoot: path.join(directory, 'bundle'),
      compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags,
      durableObjects: { PROBE: { className: 'SchemaProbe', useSQLite: true } },
      outboundService: () => { throw new Error('Unexpected unbound network access'); },
    });
    options.resourcePersistencePath = path.join(directory, 'storage');
    options.telemetry = { enabled: false };
    options.cf = false;
    runtime = new Miniflare(options);
    await runtime.ready;
  });
  test.after(async () => {
    await runtime?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  async function request(object, action, expectedStatus = 200) {
    const separator = action.includes('?') ? '&' : '?';
    const response = await runtime.dispatchFetch(`https://schema.example${action}${separator}object=${object}`);
    const body = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(body));
    return body;
  }

  test('upgrades an unversioned database, preserves history, and persists the version across restart', async () => {
    const original = await request('legacy', '/seed');
    const pragma = await request('legacy', '/pragma-support');
    assert.equal(pragma.userVersionSupported, false);
    assert.ok(pragma.messageColumns.some(column => column.name === 'content'));
    const migrated = await request('legacy', '/migrate');
    assert.equal(migrated.version, 1);
    assert.deepEqual(migrated.conversations, original.conversations.map(row => ({ ...row, is_private: 0, is_branch: 0 })));
    assert.deepEqual(migrated.messages, original.messages.map(row => ({ ...row, attachments_json: '[]' })));
    assert.deepEqual(await request('legacy', '/migrate'), migrated, 'repeated initialization is idempotent');
    await runtime.dispose();
    runtime = new Miniflare(options);
    assert.deepEqual(await request('legacy', '/state'), migrated);
  });

  test('rolls back schema and version after an injected migration failure, then retries successfully', async () => {
    const original = await request('rollback', '/seed');
    const failure = await request('rollback', '/migrate?failAfterVersion=1', 409);
    assert.match(failure.error, /Synthetic failure after writing migration version/);
    assert.deepEqual(await request('rollback', '/state'), original, 'native transaction rolled back DDL, rows and version table');
    await runtime.dispose();
    runtime = new Miniflare(options);
    assert.deepEqual(await request('rollback', '/state'), original, 'failed migration remains rolled back after restart');
    const retried = await request('rollback', '/migrate');
    assert.equal(retried.version, 1);
    assert.equal(retried.messages[0].content, 'Preserve answer');
    assert.deepEqual(await request('rollback', '/transaction-failure'), { rolledBack: true });
    const committed = await request('rollback', '/transaction-retry');
    assert.deepEqual(committed.settings, [{ key: 'fixture-key', value: 'retry', updated_at: '2026-01-01' }]);
    await runtime.dispose();
    runtime = new Miniflare(options);
    assert.deepEqual(await request('rollback', '/state'), committed);
  });

  test('refuses a newer schema without changing its rows or version, including after restart', async () => {
    await request('future', '/seed');
    await request('future', '/migrate');
    const newer = await request('future', '/future-version');
    assert.equal(newer.version, 2);
    assert.match((await request('future', '/migrate', 409)).error, /Unsupported database schema version/);
    assert.deepEqual(await request('future', '/state'), newer);
    await runtime.dispose();
    runtime = new Miniflare(options);
    assert.match((await request('future', '/migrate', 409)).error, /Unsupported database schema version/);
    assert.deepEqual(await request('future', '/state'), newer);
  });
});
