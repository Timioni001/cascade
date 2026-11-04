import { SCHEMA, SqlStore, type Row, type SqlDriver } from "./sql.js";

/**
 * The store on Node's built-in `node:sqlite` (Node >= 22.13): no native
 * module to compile. One process; swap for Postgres behind the same `Store`
 * interface for more.
 */
type NodeDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): Row | undefined; all(...a: unknown[]): Row[] };
};

export class SqliteStore extends SqlStore {
  static async open(path: string): Promise<SqliteStore> {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (p: string) => NodeDb };
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    const driver: SqlDriver = {
      async run(sql, ...a) {
        db.prepare(sql).run(...a);
      },
      async first(sql, ...a) {
        return db.prepare(sql).get(...a) ?? null;
      },
      async all(sql, ...a) {
        return db.prepare(sql).all(...a);
      },
    };
    return new SqliteStore(driver);
  }
}

/** The subset of Cloudflare's D1Database binding the store uses. */
export interface D1Like {
  prepare(sql: string): { bind(...a: unknown[]): { run(): Promise<unknown>; first(): Promise<Row | null>; all(): Promise<{ results: Row[] }> } };
}

/** The store on Cloudflare D1. Apply migrations/0001_init.sql first (`wrangler d1 migrations apply`). */
export class D1Store extends SqlStore {
  constructor(d1: D1Like) {
    super({
      async run(sql, ...a) {
        await d1.prepare(sql).bind(...a).run();
      },
      async first(sql, ...a) {
        return d1.prepare(sql).bind(...a).first();
      },
      async all(sql, ...a) {
        return (await d1.prepare(sql).bind(...a).all()).results;
      },
    });
  }
}
