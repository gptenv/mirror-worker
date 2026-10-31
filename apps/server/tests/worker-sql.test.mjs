import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes } from 'node:crypto';
import { ChatGptBackendClient } from '@mirror/protocol';
import { stubBackend } from './helpers/backend.mjs';
import { wrapDurableSql, wrapNodeDatabase } from '../dist/worker-sql.js';

// Cloudflare puts exec on storage.sql and transactionSync on storage.
const database = new DatabaseSync(':memory:');
let transactions = 0;
const storage = {
  sql: {
    exec(sql, ...values) {
      if (!values.length && /CREATE TABLE/i.test(sql)) {
        database.exec(sql);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const statement = database.prepare(sql);
      if (statement.columns().length) return { toArray: () => statement.all(...values), rowsWritten: 0 };
      const result = statement.run(...values);
      return { toArray: () => [], rowsWritten: Number(result.changes) };
    },
  },
  transactionSync(work) {
    assert.equal(this, storage);
    transactions++;
    database.exec('BEGIN IMMEDIATE');
    try { const result = work(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  },
};
globalThis.WebSocketPair = class {};
const { initializeWorkerStore, storedDatabaseSchemaVersion, getConversation, listMessages, setImplicitConversationId, getSession, saveVerifiedSession, createConversation, updateConversation, addMessage, setDefaultSystemInstructions, getDefaultSystemInstructions } = await import('../dist/store.js');
initializeWorkerStore(storage, 'a'.repeat(64));
const { buildApp } = await import('../dist/index.js');

function seedLegacySession(metadata) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from('a'.repeat(64), 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(metadata), 'utf8'), cipher.final()]);
  const sealed = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  database.prepare("INSERT INTO settings VALUES ('session', ?, 'fixture') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(sealed);
}

test.describe('server / worker-sql', () => {
  test.after(() => { database.close(); delete globalThis.WebSocketPair; });
  test('invalid or missing encryption keys fail before touching storage', () => {
    const untouched = { sql: { exec() { assert.fail('storage must not be accessed'); } }, transactionSync() { assert.fail('storage must not be accessed'); } };
    assert.throws(() => initializeWorkerStore(untouched), /MIRROR_STORE_KEY secret is required/);
    assert.throws(() => initializeWorkerStore(untouched, 'invalid'), /must decode to exactly 32 bytes/);
  });
  test('reports the persisted Worker version rather than a binary constant', () => {
    assert.equal(storedDatabaseSchemaVersion(), 1);
    database.exec('UPDATE mirror_schema SET version = 7');
    try { assert.equal(storedDatabaseSchemaVersion(), 7); }
    finally { database.exec('UPDATE mirror_schema SET version = 1'); }
  });
  test('Worker restart removes legacy credentials and retains valid account metadata', () => {
    const metadata = { deviceId: 'existing-device', savedAt: '2026-01-01T00:00:00.000Z', accountId: 'fixture-owner', assetLinkGeneration: 'existing-generation', turnstileToken: 'fixture-turnstile', turnstileTokenSavedAt: 123 };
    seedLegacySession({ ...metadata, sessionToken: 'fixture-session-secret', cachedAccessToken: 'fixture-access-secret', cachedAccessTokenExpiresAt: 999 });
    initializeWorkerStore(storage, 'a'.repeat(64));
    assert.deepEqual(getSession(), metadata);
    initializeWorkerStore(storage, 'a'.repeat(64));
    assert.deepEqual(getSession(), metadata, 'repeated startup must preserve the sanitized metadata');
    const updated = saveVerifiedSession('fixture-owner');
    assert.equal(updated.deviceId, 'existing-device', 'revalidation without a new device must retain the device');
    assert.equal(updated.turnstileToken, 'fixture-turnstile');
    assert.equal(updated.turnstileTokenSavedAt, 123);
    assert.notEqual(updated.assetLinkGeneration, 'existing-generation');
    const switched = saveVerifiedSession('different-owner');
    assert.notEqual(switched.deviceId, 'existing-device');
    assert.equal(switched.turnstileToken, undefined);
    assert.equal(switched.turnstileTokenSavedAt, undefined);
    database.exec("DELETE FROM settings WHERE key = 'session'");
  });
  test('Worker restart repairs incomplete legacy metadata without retaining unknown fields', () => {
    const before = Date.now();
    seedLegacySession({ sessionToken: 'fixture-session-secret', deviceId: 42, savedAt: null, accountId: [], assetLinkGeneration: false, turnstileToken: 7, turnstileTokenSavedAt: 'invalid', unexpected: 'discard' });
    initializeWorkerStore(storage, 'a'.repeat(64));
    const session = getSession();
    assert.deepEqual(Object.keys(session).sort(), ['deviceId', 'savedAt']);
    assert.match(session.deviceId, /^[a-f0-9-]{36}$/);
    assert.ok(Date.parse(session.savedAt) >= before);
    assert.ok(Date.parse(session.savedAt) <= Date.now());
    database.exec("DELETE FROM settings WHERE key = 'session'");
  });
  test('Worker restart drops unreadable session metadata but preserves settings and interrupted history', () => {
    setDefaultSystemInstructions('fixture-owner', 'Retain this instruction');
    const conversation = createConversation({ model: 'auto', accountId: 'fixture-owner' });
    updateConversation({ ...conversation, conversationId: 'upstream-retained', currentNodeId: 'last-completed-node' });
    addMessage({ conversationId: conversation.id, upstreamNodeId: 'partial-node', role: 'assistant', content: 'Partial answer', status: 'streaming', events: [] });
    database.prepare("INSERT INTO settings VALUES ('session', ?, 'fixture')").run('damaged-ciphertext');
    initializeWorkerStore(storage, 'a'.repeat(64));
    assert.equal(getSession(), null);
    assert.equal(getDefaultSystemInstructions('fixture-owner'), 'Retain this instruction');
    assert.equal(getConversation(conversation.id).currentNodeId, 'last-completed-node');
    assert.equal(getConversation(conversation.id).conversationId, 'upstream-retained');
    assert.equal(listMessages(conversation.id)[0].content, 'Partial answer');
    assert.equal(listMessages(conversation.id)[0].status, 'interrupted');
    assert.equal(storedDatabaseSchemaVersion(), 1);
  });
  test('transactions run on storage and roll back failed writes', () => {
    const db = wrapDurableSql(storage);
    db.exec('CREATE TABLE rollback_probe (value TEXT)');
    assert.throws(() => db.transaction(() => { db.prepare('INSERT INTO rollback_probe VALUES (?)').run('discard'); throw new Error('rollback'); }), /rollback/);
    assert.deepEqual(db.prepare('SELECT * FROM rollback_probe').all(), []);
  });
  test('Durable SQL forwards PRAGMAs and propagates unsupported SQL errors', () => {
    const statements = [];
    const db = wrapDurableSql({
      ...storage,
      sql: { exec(sql) {
        statements.push(sql);
        if (sql === 'PRAGMA user_version = 2') throw new Error('unsupported pragma');
        return { toArray: () => [], rowsWritten: 0 };
      } },
    });
    db.exec('PRAGMA table_info(messages)');
    assert.throws(() => db.exec('PRAGMA user_version = 2'), /unsupported pragma/);
    assert.deepEqual(statements, ['PRAGMA table_info(messages)', 'PRAGMA user_version = 2']);
  });
  test('Node SQLite adapter supports queries and commits or rolls back transactions', () => {
    const native = new DatabaseSync(':memory:');
    try {
      const db = wrapNodeDatabase(native);
      db.exec('CREATE TABLE items (value TEXT)');
      const insert = db.prepare('INSERT INTO items VALUES (?)');
      const select = db.prepare('SELECT value FROM items');
      db.transaction(() => insert.run('saved'));
      assert.equal(select.get().value, 'saved');
      assert.equal(select.all().length, 1);
      assert.throws(() => db.transaction(() => { insert.run('rolled-back'); throw new Error('rollback'); }), /rollback/);
      assert.equal(select.all().length, 1);
    } finally { native.close(); }
  });
  for (const stream of [false, true]) test(`saved ${stream ? 'streaming' : 'JSON'} completion finishes and retains its answer`, async () => {
    setImplicitConversationId('default', null);
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', stubBackend('worker-storage'));
    test.mock.method(ChatGptBackendClient.prototype, 'sendMessage', async () => ({ text: 'Saved answer', conversationId: 'upstream-id', messageId: 'assistant-id', userMessageId: 'user-id', status: 'done', events: [] }));
    const before = transactions;
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-access' }, payload: { model: 'auto', messages: [{ role: 'user', content: 'hello' }], stream } });
      assert.equal(response.statusCode, 200, response.body);
      assert.doesNotMatch(response.body, /"error":/);
      assert.match(response.body, /Saved answer/);
      const id = stream ? response.body.match(/: mirror-conversation-id ([^\n]+)/)?.[1] : response.headers['x-mirror-conversation-id'];
      assert.ok(id, response.body);
      assert.ok(getConversation(id));
      assert.deepEqual(listMessages(id).map(({role, content}) => ({role, content})), [{role:'user',content:'hello'}, {role:'assistant',content:'Saved answer'}]);
      assert.ok(transactions > before);
      if (stream) assert.match(response.body, /"finish_reason":"stop"/);
      else assert.equal(response.json().choices[0].message.content, 'Saved answer');
    } finally { test.mock.restoreAll(); await app.close(); }
  });
});
