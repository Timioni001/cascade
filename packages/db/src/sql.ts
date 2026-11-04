import {
  matches, type ApiKey, type BatchDoc, type CheckoutSessionRecord, type InvoiceDoc, type Merchant, type PaymentFilter, type PaymentRecord, type Store,
  type RefundRecord, type WebhookDelivery,
} from "./records.js";

/**
 * The store on any SQLite: Node's built-in `node:sqlite` (SqliteStore) or
 * Cloudflare D1 (D1Store). Documents are stored as JSON with the columns we
 * query on pulled out. The schema is SCHEMA below; D1 applies it as
 * migrations/0001_init.sql (kept identical by a test).
 */
export const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS refunds (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, deposit_address TEXT NOT NULL UNIQUE, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, win INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (ns, key));
CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, merchant_id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE INDEX IF NOT EXISTS docs_merchant ON docs(kind, merchant_id);
`.trim();

export type Row = Record<string, unknown>;

/** The four things the store needs from a SQLite driver. */
export interface SqlDriver {
  run(sql: string, ...args: unknown[]): Promise<void>;
  first(sql: string, ...args: unknown[]): Promise<Row | null>;
  all(sql: string, ...args: unknown[]): Promise<Row[]>;
}

export class SqlStore implements Store {
  constructor(readonly db: SqlDriver) {}

  private async one<T>(sql: string, ...a: unknown[]): Promise<T | null> {
    const r = await this.db.first(sql, ...a);
    return r ? (JSON.parse(r.doc as string) as T) : null;
  }
  private async many<T>(sql: string, ...a: unknown[]): Promise<T[]> {
    return (await this.db.all(sql, ...a)).map((r) => JSON.parse(r.doc as string) as T);
  }

  async putInvoice(d: InvoiceDoc) {
    await this.db.run("INSERT OR REPLACE INTO invoices (id, owner, doc) VALUES (?, ?, ?)", d.id, d.owner, JSON.stringify(d));
  }
  getInvoice(id: number) {
    return this.one<InvoiceDoc>("SELECT doc FROM invoices WHERE id = ?", id);
  }
  listInvoices(owner: string) {
    return this.many<InvoiceDoc>("SELECT doc FROM invoices WHERE owner = ? ORDER BY id", owner);
  }

  async putPayment(p: PaymentRecord) {
    await this.db.run(
      "INSERT OR REPLACE INTO payments (deposit_address, owner, direction, batch_id, doc) VALUES (?, ?, ?, ?, ?)",
      p.depositAddress, p.owner, p.direction, p.batchId, JSON.stringify(p),
    );
  }
  getPayment(addr: string) {
    return this.one<PaymentRecord>("SELECT doc FROM payments WHERE deposit_address = ?", addr);
  }
  async listPayments(f?: PaymentFilter) {
    const rows = f?.owner ? await this.many<PaymentRecord>("SELECT doc FROM payments WHERE owner = ?", f.owner) : await this.many<PaymentRecord>("SELECT doc FROM payments");
    return rows.filter((p) => matches(p, f));
  }

  async putBatch(d: BatchDoc) {
    await this.db.run("INSERT OR REPLACE INTO batches (id, owner, doc) VALUES (?, ?, ?)", d.id, d.owner, JSON.stringify(d));
  }
  getBatch(id: number) {
    return this.one<BatchDoc>("SELECT doc FROM batches WHERE id = ?", id);
  }
  listBatches(owner?: string) {
    return owner ? this.many<BatchDoc>("SELECT doc FROM batches WHERE owner = ? ORDER BY id", owner) : this.many<BatchDoc>("SELECT doc FROM batches ORDER BY id");
  }

  async putMerchant(m: Merchant) {
    await this.db.run("INSERT OR REPLACE INTO merchants (id, account, doc) VALUES (?, ?, ?)", m.id, m.account, JSON.stringify(m));
  }
  getMerchant(id: string) {
    return this.one<Merchant>("SELECT doc FROM merchants WHERE id = ?", id);
  }
  findMerchantByAccount(account: string) {
    return this.one<Merchant>("SELECT doc FROM merchants WHERE account = ?", account);
  }
  listMerchants() {
    return this.many<Merchant>("SELECT doc FROM merchants ORDER BY id");
  }

  async putApiKey(k: ApiKey) {
    await this.db.run("INSERT OR REPLACE INTO api_keys (hash, merchant_id, doc) VALUES (?, ?, ?)", k.hash, k.merchantId, JSON.stringify(k));
  }
  getApiKey(hash: string) {
    return this.one<ApiKey>("SELECT doc FROM api_keys WHERE hash = ?", hash);
  }

  async putSession(s: CheckoutSessionRecord) {
    await this.db.run(
      "INSERT OR REPLACE INTO sessions (id, merchant_id, idem, created_at, doc) VALUES (?, ?, ?, ?, ?)",
      s.id, s.merchantId, s.idempotencyKey, s.createdAt, JSON.stringify(s),
    );
  }
  getSession(id: string) {
    return this.one<CheckoutSessionRecord>("SELECT doc FROM sessions WHERE id = ?", id);
  }
  listSessions(merchantId: string, limit = 50) {
    return this.many<CheckoutSessionRecord>("SELECT doc FROM sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?", merchantId, limit);
  }
  findSessionByIdempotencyKey(merchantId: string, key: string) {
    return this.one<CheckoutSessionRecord>("SELECT doc FROM sessions WHERE merchant_id = ? AND idem = ?", merchantId, key);
  }

  async putRefund(r: RefundRecord) {
    await this.db.run("INSERT OR REPLACE INTO refunds (id, session_id, deposit_address, doc) VALUES (?, ?, ?, ?)", r.id, r.sessionId, r.depositAddress, JSON.stringify(r));
  }
  getRefund(id: string) {
    return this.one<RefundRecord>("SELECT doc FROM refunds WHERE id = ?", id);
  }
  listRefunds(sessionId: string) {
    return this.many<RefundRecord>("SELECT doc FROM refunds WHERE session_id = ? ORDER BY id", sessionId);
  }
  async listOpenRefunds() {
    return (await this.many<RefundRecord>("SELECT doc FROM refunds ORDER BY id")).filter((r) => r.status !== "succeeded" && r.status !== "failed");
  }
  findRefundByDeposit(dep: string) {
    return this.one<RefundRecord>("SELECT doc FROM refunds WHERE deposit_address = ?", dep);
  }

  async putWebhook(w: WebhookDelivery) {
    await this.db.run(
      "INSERT OR REPLACE INTO webhooks (id, merchant_id, status, next_at, doc) VALUES (?, ?, ?, ?, ?)",
      w.id, w.merchantId, w.status, w.nextAttemptAt, JSON.stringify(w),
    );
  }
  getWebhook(id: string) {
    return this.one<WebhookDelivery>("SELECT doc FROM webhooks WHERE id = ?", id);
  }
  listDueWebhooks(nowIso: string) {
    return this.many<WebhookDelivery>("SELECT doc FROM webhooks WHERE status = 'pending' AND next_at <= ? ORDER BY next_at", nowIso);
  }
  listWebhooks(merchantId: string) {
    return this.many<WebhookDelivery>("SELECT doc FROM webhooks WHERE merchant_id = ? ORDER BY next_at", merchantId);
  }

  async putDoc<T>(kind: string, id: string, merchantId: string, doc: T) {
    // Upsert keeps the row (and so its rowid order) when a document is updated.
    await this.db.run(
      "INSERT INTO docs (kind, id, merchant_id, doc) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET doc = excluded.doc, merchant_id = excluded.merchant_id",
      kind, id, merchantId, JSON.stringify(doc),
    );
  }
  getDoc<T>(kind: string, id: string) {
    return this.one<T>("SELECT doc FROM docs WHERE kind = ? AND id = ?", kind, id);
  }
  listDocs<T>(kind: string, merchantId?: string) {
    return merchantId === undefined
      ? this.many<T>("SELECT doc FROM docs WHERE kind = ? ORDER BY rowid", kind)
      : this.many<T>("SELECT doc FROM docs WHERE kind = ? AND merchant_id = ? ORDER BY rowid", kind, merchantId);
  }

  async claimOnce(key: string, ttlMs: number, now: number) {
    // One statement, so it is atomic: insert, or take over an expired claim.
    const r = await this.db.first(
      "INSERT INTO claims (key, until) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until WHERE claims.until <= ? RETURNING until",
      key, now + ttlMs, now,
    );
    return r !== null;
  }
  async hit(key: string, windowMs: number, now: number, add = 1) {
    const r = await this.db.first(
      "INSERT INTO counters (key, win, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET " +
        "count = CASE WHEN counters.win = excluded.win THEN counters.count + excluded.count ELSE excluded.count END, win = excluded.win RETURNING count",
      key, Math.floor(now / windowMs), add,
    );
    return Number(r?.count ?? 0);
  }

  /** A small namespaced document table for hosts' own state (simulated swaps, the demo shop's orders). */
  kv<T>(ns: string) {
    return {
      get: async (key: string): Promise<T | null> => {
        const r = await this.db.first("SELECT doc FROM kv WHERE ns = ? AND key = ?", ns, key);
        return r ? (JSON.parse(r.doc as string) as T) : null;
      },
      put: async (key: string, v: T): Promise<void> => {
        await this.db.run("INSERT OR REPLACE INTO kv (ns, key, doc) VALUES (?, ?, ?)", ns, key, JSON.stringify(v));
      },
      keys: async (): Promise<string[]> => (await this.db.all("SELECT key FROM kv WHERE ns = ? ORDER BY rowid", ns)).map((r) => r.key as string),
    };
  }
}
