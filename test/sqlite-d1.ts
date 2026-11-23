// A D1 stand-in over node:sqlite, in memory: prepare/bind/all/run plus batch, running the outbox's real SQL.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { D1StatementLike } from "../src/outbox.js";

export interface SqliteD1 {
  exec(sql: string): void;
  raw: DatabaseSync;
  prepare(sql: string): Stmt;
  batch(statements: Stmt[]): Promise<unknown[]>;
}
export interface Stmt extends D1StatementLike {
  bind(...values: unknown[]): Stmt;
}

export function sqliteD1(): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  const statement = (sql: string, values: unknown[]): Stmt => ({
    bind: (...next) => statement(sql, next),
    async all<T>() {
      return { results: raw.prepare(sql).all(...(values as SQLInputValue[])) as T[] };
    },
    async run() {
      const r = raw.prepare(sql).run(...(values as SQLInputValue[]));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  const db: SqliteD1 = {
    raw,
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      raw.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        raw.exec("commit");
        return out;
      } catch (e) {
        raw.exec("rollback");
        throw e;
      }
    },
  };
  return db;
}
