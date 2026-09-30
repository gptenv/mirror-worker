import type { DatabaseSync } from "node:sqlite";

export interface SqliteStatement {
  run(...values: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(work: () => T): T;
}

export interface DurableSqlStorage {
  exec(sql: string, ...values: unknown[]): {
    toArray(): unknown[];
    readonly rowsWritten: number;
  };
  transactionSync<T>(work: () => T): T;
}

export function wrapNodeDatabase(database: DatabaseSync): SqliteDatabase {
  return {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run: (...values) => (statement.run as (...args: unknown[]) => ReturnType<typeof statement.run>)(...values),
        get: (...values) => (statement.get as (...args: unknown[]) => unknown)(...values),
        all: (...values) => (statement.all as (...args: unknown[]) => unknown[])(...values),
      };
    },
    transaction(work) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function wrapDurableSql(storage: DurableSqlStorage): SqliteDatabase {
  return {
    exec(sql) {
      // PRAGMAs are configured by Cloudflare's SQLite-backed Durable Object
      // storage and are not part of its SQL API.
      if (/^\s*PRAGMA\b/i.test(sql)) return;
      return storage.exec(sql);
    },
    prepare(sql) {
      return {
        run(...values) {
          const cursor = storage.exec(sql, ...values);
          return { changes: cursor.rowsWritten };
        },
        get(...values) {
          return storage.exec(sql, ...values).toArray()[0];
        },
        all(...values) {
          return storage.exec(sql, ...values).toArray();
        },
      };
    },
    transaction(work) {
      return storage.transactionSync(work);
    },
  };
}
