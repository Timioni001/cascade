import {
  matches, type ApiKey, type BatchDoc, type CheckoutSessionRecord, type InvoiceDoc, type Merchant, type PaymentFilter, type PaymentRecord, type Store,
  type WebhookDelivery,
} from "./records.js";

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
      CREATE TABLE IF NOT EXISTS merchants (id TEXT PRIMARY KEY, account TEXT NOT NULL UNIQUE, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (hash TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, idem TEXT, created_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_idem ON sessions(merchant_id, idem) WHERE idem IS NOT NULL;
      CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, status TEXT NOT NULL, next_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS webhooks_due ON webhooks(status, next_at);
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

  private one<T>(sql: string, ...a: unknown[]): T | null {
    const r = this.db.prepare(sql).get(...a);
    return r ? (JSON.parse(r.doc) as T) : null;
  }
  private many<T>(sql: string, ...a: unknown[]): T[] {
    return this.db.prepare(sql).all(...a).map((r) => JSON.parse(r.doc) as T);
  }
  async putMerchant(m: Merchant) {
    this.db.prepare("INSERT OR REPLACE INTO merchants (id, account, doc) VALUES (?, ?, ?)").run(m.id, m.account, JSON.stringify(m));
  }
  async getMerchant(id: string) {
    return this.one<Merchant>("SELECT doc FROM merchants WHERE id = ?", id);
  }
  async findMerchantByAccount(account: string) {
    return this.one<Merchant>("SELECT doc FROM merchants WHERE account = ?", account);
  }
  async listMerchants() {
    return this.many<Merchant>("SELECT doc FROM merchants ORDER BY id");
  }
  async putApiKey(k: ApiKey) {
    this.db.prepare("INSERT OR REPLACE INTO api_keys (hash, merchant_id, doc) VALUES (?, ?, ?)").run(k.hash, k.merchantId, JSON.stringify(k));
  }
  async getApiKey(hash: string) {
    return this.one<ApiKey>("SELECT doc FROM api_keys WHERE hash = ?", hash);
  }
  async putSession(s: CheckoutSessionRecord) {
    this.db
      .prepare("INSERT OR REPLACE INTO sessions (id, merchant_id, idem, created_at, doc) VALUES (?, ?, ?, ?, ?)")
      .run(s.id, s.merchantId, s.idempotencyKey, s.createdAt, JSON.stringify(s));
  }
  async getSession(id: string) {
    return this.one<CheckoutSessionRecord>("SELECT doc FROM sessions WHERE id = ?", id);
  }
  async listSessions(merchantId: string, limit = 50) {
    return this.many<CheckoutSessionRecord>("SELECT doc FROM sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?", merchantId, limit);
  }
  async findSessionByIdempotencyKey(merchantId: string, key: string) {
    return this.one<CheckoutSessionRecord>("SELECT doc FROM sessions WHERE merchant_id = ? AND idem = ?", merchantId, key);
  }
  async putWebhook(w: WebhookDelivery) {
    this.db
      .prepare("INSERT OR REPLACE INTO webhooks (id, merchant_id, status, next_at, doc) VALUES (?, ?, ?, ?, ?)")
      .run(w.id, w.merchantId, w.status, w.nextAttemptAt, JSON.stringify(w));
  }
  async listDueWebhooks(nowIso: string) {
    return this.many<WebhookDelivery>("SELECT doc FROM webhooks WHERE status = 'pending' AND next_at <= ? ORDER BY next_at", nowIso);
  }
  async listWebhooks(merchantId: string) {
    return this.many<WebhookDelivery>("SELECT doc FROM webhooks WHERE merchant_id = ? ORDER BY next_at", merchantId);
  }
}
