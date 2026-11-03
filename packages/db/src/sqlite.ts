import { matches, type BatchDoc, type InvoiceDoc, type PaymentFilter, type PaymentRecord, type Store } from "./records.js";

/**
 * SQLite store on Node's built-in `node:sqlite` (Node >= 22.13): no native
 * module to compile. Documents are stored as JSON with the columns we query
 * on pulled out. Swap for Postgres behind the same `Store` interface when
 * running more than one process.
 */
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): { doc: string } | undefined; all(...a: unknown[]): { doc: string }[] };
};

export class SqliteStore implements Store {
  private constructor(private readonly db: Db) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS invoices_owner ON invoices(owner);
      CREATE TABLE IF NOT EXISTS payments (deposit_address TEXT PRIMARY KEY, owner TEXT NOT NULL, direction TEXT NOT NULL, batch_id INTEGER, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payments_owner ON payments(owner);
      CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, doc TEXT NOT NULL);
    `);
  }

  static async open(path: string): Promise<SqliteStore> {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (p: string) => Db };
    return new SqliteStore(new DatabaseSync(path));
  }

  async putInvoice(d: InvoiceDoc) {
    this.db.prepare("INSERT OR REPLACE INTO invoices (id, owner, doc) VALUES (?, ?, ?)").run(d.id, d.owner, JSON.stringify(d));
  }
  async getInvoice(id: number) {
    const r = this.db.prepare("SELECT doc FROM invoices WHERE id = ?").get(id);
    return r ? (JSON.parse(r.doc) as InvoiceDoc) : null;
  }
  async listInvoices(owner: string) {
    return this.db.prepare("SELECT doc FROM invoices WHERE owner = ? ORDER BY id").all(owner).map((r) => JSON.parse(r.doc) as InvoiceDoc);
  }
  async putPayment(p: PaymentRecord) {
    this.db
      .prepare("INSERT OR REPLACE INTO payments (deposit_address, owner, direction, batch_id, doc) VALUES (?, ?, ?, ?, ?)")
      .run(p.depositAddress, p.owner, p.direction, p.batchId, JSON.stringify(p));
  }
  async getPayment(addr: string) {
    const r = this.db.prepare("SELECT doc FROM payments WHERE deposit_address = ?").get(addr);
    return r ? (JSON.parse(r.doc) as PaymentRecord) : null;
  }
  async listPayments(f?: PaymentFilter) {
    const rows = f?.owner
      ? this.db.prepare("SELECT doc FROM payments WHERE owner = ?").all(f.owner)
      : this.db.prepare("SELECT doc FROM payments").all();
    return rows.map((r) => JSON.parse(r.doc) as PaymentRecord).filter((p) => matches(p, f));
  }
  async putBatch(d: BatchDoc) {
    this.db.prepare("INSERT OR REPLACE INTO batches (id, owner, doc) VALUES (?, ?, ?)").run(d.id, d.owner, JSON.stringify(d));
  }
  async getBatch(id: number) {
    const r = this.db.prepare("SELECT doc FROM batches WHERE id = ?").get(id);
    return r ? (JSON.parse(r.doc) as BatchDoc) : null;
  }
  async listBatches(owner?: string) {
    const rows = owner ? this.db.prepare("SELECT doc FROM batches WHERE owner = ? ORDER BY id").all(owner) : this.db.prepare("SELECT doc FROM batches ORDER BY id").all();
    return rows.map((r) => JSON.parse(r.doc) as BatchDoc);
  }
}
