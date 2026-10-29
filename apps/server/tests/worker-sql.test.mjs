import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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
const { initializeWorkerStore, getConversation, listMessages, setImplicitConversationId } = await import('../dist/store.js');
initializeWorkerStore(storage, 'a'.repeat(64));
const { buildApp } = await import('../dist/index.js');

test.describe('server / worker-sql', () => {
  test.after(() => { database.close(); delete globalThis.WebSocketPair; });
  test('invalid or missing encryption keys fail before touching storage', () => {
    const untouched = { sql: { exec() { assert.fail('storage must not be accessed'); } }, transactionSync() { assert.fail('storage must not be accessed'); } };
    assert.throws(() => initializeWorkerStore(untouched), /MIRROR_STORE_KEY secret is required/);
    assert.throws(() => initializeWorkerStore(untouched, 'invalid'), /must decode to exactly 32 bytes/);
  });
  test('transactions run on storage and roll back failed writes', () => {
    const db = wrapDurableSql(storage);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE rollback_probe (value TEXT)');
    assert.throws(() => db.transaction(() => { db.prepare('INSERT INTO rollback_probe VALUES (?)').run('discard'); throw new Error('rollback'); }), /rollback/);
    assert.deepEqual(db.prepare('SELECT * FROM rollback_probe').all(), []);
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
