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
  sql: {
    exec(sql: string, ...values: unknown[]): {
      toArray(): unknown[];
      readonly rowsWritten: number;
    };
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
      // Let the runtime accept supported PRAGMAs (such as table_info) and
      // reject unsupported ones; silently skipping SQL can hide migrations.
      return storage.sql.exec(sql);
    },
    prepare(sql) {
      return {
        run(...values) {
          const cursor = storage.sql.exec(sql, ...values);
          return { changes: cursor.rowsWritten };
        },
        get(...values) {
          return storage.sql.exec(sql, ...values).toArray()[0];
        },
        all(...values) {
          return storage.sql.exec(sql, ...values).toArray();
        },
      };
    },
    transaction(work) {
      return storage.transactionSync(work);
    },
  };
}
