import { DurableObject } from 'cloudflare:workers';
import { migrateWorkerDatabase, workerDatabaseSchemaVersion } from '../../../apps/server/src/schema.js';
import { wrapDurableSql } from '../../../apps/server/src/worker-sql.js';

// Test-only entry point. Production migration code runs against native DO SQL;
// the probe exposes no deployment route and uses only synthetic local storage.
export class SchemaProbe extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const db = wrapDurableSql(this.ctx.storage);
    const url = new URL(request.url);
    const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf%' ORDER BY name").all() as { name: string }[];
    if (url.pathname === '/seed') {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT 'default', upstream_id TEXT,
          current_node_id TEXT NOT NULL, model TEXT NOT NULL, gizmo_id TEXT, title TEXT NOT NULL,
          initialized INTEGER NOT NULL DEFAULT 0, init_json TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          upstream_node_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
          events_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
        );
        INSERT INTO conversations (id, account_id, current_node_id, model, title, created_at, updated_at)
          VALUES ('fixture-conversation', 'fixture-owner', 'fixture-parent', 'auto', 'Preserve me', '2026-01-01', '2026-01-01');
        INSERT INTO messages (id, conversation_id, role, content, status, created_at)
          VALUES ('fixture-message', 'fixture-conversation', 'assistant', 'Preserve answer', 'done', '2026-01-01');
      `);
    } else if (url.pathname === '/migrate') {
      try {
        const adapter = url.searchParams.has('failAfterVersion') ? {
          ...db,
          prepare(sql: string) {
            const statement = db.prepare(sql);
            if (!sql.startsWith('INSERT INTO mirror_schema')) return statement;
            return { ...statement, run(...values: unknown[]) {
              statement.run(...values);
              throw new Error('Synthetic failure after writing migration version');
            } };
          },
        } : db;
        migrateWorkerDatabase(adapter);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 409 });
      }
    } else if (url.pathname === '/future-version') {
      db.prepare('UPDATE mirror_schema SET version = ? WHERE id = 1').run(2);
    } else if (url.pathname === '/transaction-failure') {
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('fixture-key', 'first', '2026-01-01');
          db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('fixture-key', 'duplicate', '2026-01-01');
        });
      } catch {
        return Response.json({ rolledBack: db.prepare('SELECT * FROM settings').all().length === 0 });
      }
      return Response.json({ rolledBack: false }, { status: 500 });
    } else if (url.pathname === '/transaction-retry') {
      db.transaction(() => db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('fixture-key', 'retry', '2026-01-01'));
    } else if (url.pathname === '/pragma-support') {
      let userVersionSupported = false;
      try { this.ctx.storage.sql.exec('PRAGMA user_version').toArray(); userVersionSupported = true; } catch {}
      return Response.json({ userVersionSupported, messageColumns: db.prepare('PRAGMA table_info(messages)').all() });
    }
    const names = tables().map(row => row.name);
    return Response.json({
      tables: names,
      version: names.includes('mirror_schema') ? workerDatabaseSchemaVersion(db) : null,
      conversations: db.prepare('SELECT * FROM conversations ORDER BY id').all(),
      messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
      settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
    });
  }
}

export default {
  fetch(request: Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
    const name = new URL(request.url).searchParams.get('object') ?? 'fixture';
    return env.PROBE.get(env.PROBE.idFromName(name)).fetch(request);
  },
};
