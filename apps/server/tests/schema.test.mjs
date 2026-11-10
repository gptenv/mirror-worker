import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase, databaseSchemaVersion, DATABASE_SCHEMA_VERSION, migrateWorkerDatabase, workerDatabaseSchemaVersion } from "../dist/schema.js";

import { wrapNodeDatabase } from "../dist/worker-sql.js";

test.describe("server / schema", () => {
  test("fresh databases get a numbered baseline and repeated startup preserves data", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateDatabase(db);
      assert.equal(databaseSchemaVersion(db), DATABASE_SCHEMA_VERSION);
      db.exec("INSERT INTO settings VALUES ('fixture', 'retained', 'today')");
      migrateDatabase(db);
      assert.equal(db.prepare("SELECT value FROM settings").get().value, "retained");
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { db.close(); }
  });

  test("a failed legacy upgrade rolls back schema changes and version together", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // A damaged legacy messages table makes index creation fail midway.
      db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)");
      assert.throws(() => migrateDatabase(db), /no such column/);
      assert.equal(databaseSchemaVersion(db), 0);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name), ["messages"]);
      db.exec("DROP TABLE messages");
      migrateDatabase(db);
      assert.equal(databaseSchemaVersion(db), DATABASE_SCHEMA_VERSION);
    } finally { db.close(); }
  });

  test("newer and invalid database versions are rejected without modification", () => {
    for (const version of [DATABASE_SCHEMA_VERSION + 1, -1]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(`PRAGMA user_version = ${version}`);
        assert.throws(() => migrateDatabase(db), /Unsupported database schema/);
        assert.equal(databaseSchemaVersion(db), version);
        assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n, 0);
      } finally { db.close(); }
    }
  });
  test("Worker baseline adopts unversioned data and records its own durable version", () => {
    const native = new DatabaseSync(":memory:");
    const db = wrapNodeDatabase(native);
    try {
      migrateDatabase(native);
      native.exec("PRAGMA user_version = 0; INSERT INTO settings VALUES ('fixture', 'retained', 'today')");
      migrateWorkerDatabase(db);
      assert.equal(workerDatabaseSchemaVersion(db), DATABASE_SCHEMA_VERSION);
      assert.equal(databaseSchemaVersion(native), 0, "Worker version does not depend on unsupported user_version");
      migrateWorkerDatabase(db);
      assert.equal(native.prepare("SELECT value FROM settings").get().value, "retained");
    } finally { native.close(); }
  });

  test("Worker legacy upgrade adds missing columns without losing conversations", () => {
    const native = new DatabaseSync(":memory:");
    const db = wrapNodeDatabase(native);
    try {
      migrateDatabase(native);
      native.exec("ALTER TABLE conversations DROP COLUMN is_private; ALTER TABLE conversations DROP COLUMN is_branch; ALTER TABLE messages DROP COLUMN attachments_json;");
      native.exec("INSERT INTO conversations (id, account_id, current_node_id, model, title, created_at, updated_at) VALUES ('legacy', 'default', 'node', 'auto', 'Saved', 'today', 'today')");
      migrateWorkerDatabase(db);
      const row = native.prepare("SELECT * FROM conversations").get();
      assert.equal(row.title, "Saved");
      assert.equal(row.is_private, 0);
      assert.equal(row.is_branch, 0);
      assert.ok(native.prepare("PRAGMA table_info(messages)").all().some(c => c.name === "attachments_json"));
    } finally { native.close(); }
  });

  test("Worker failed migration rolls back all DDL and its version table", () => {
    const native = new DatabaseSync(":memory:");
    const db = wrapNodeDatabase(native);
    try {
      native.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)");
      assert.throws(() => migrateWorkerDatabase(db), /no such column/);
      assert.deepEqual(native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name), ["messages"]);
      native.exec("DROP TABLE messages");
      migrateWorkerDatabase(db);
      assert.equal(workerDatabaseSchemaVersion(db), DATABASE_SCHEMA_VERSION);
    } finally { native.close(); }
  });

  test("Worker rejects future, negative and fractional versions without changing data", () => {
    for (const version of [DATABASE_SCHEMA_VERSION + 1, -1, 0.5]) {
      const native = new DatabaseSync(":memory:");
      const db = wrapNodeDatabase(native);
      try {
        migrateWorkerDatabase(db);
        native.prepare("UPDATE mirror_schema SET version = ?").run(version);
        assert.throws(() => migrateWorkerDatabase(db), /Unsupported database schema/);
        assert.equal(workerDatabaseSchemaVersion(db), version);
      } finally { native.close(); }
    }
  });

});
