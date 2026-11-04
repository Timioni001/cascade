import {
  matches, type ApiKey, type BatchDoc, type CheckoutSessionRecord, type InvoiceDoc, type Merchant, type PaymentFilter, type PaymentRecord, type Store,
  type RefundRecord, type WebhookDelivery,
} from "./records.js";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private invoices = new Map<number, InvoiceDoc>();
  private payments = new Map<string, PaymentRecord>();
  private batches = new Map<number, BatchDoc>();
  private merchants = new Map<string, Merchant>();
  private keys = new Map<string, ApiKey>();
  private sessions = new Map<string, CheckoutSessionRecord>();
  private hooks = new Map<string, WebhookDelivery>();
  private refunds = new Map<string, RefundRecord>();
  private claims = new Map<string, number>();
  private counters = new Map<string, { window: number; count: number }>();

  async claimOnce(key: string, ttlMs: number, now: number) {
    const until = this.claims.get(key);
    if (until !== undefined && until > now) return false;
    this.claims.set(key, now + ttlMs);
    return true;
  }
  async hit(key: string, windowMs: number, now: number, add = 1) {
    const window = Math.floor(now / windowMs);
    const c = this.counters.get(key);
    const count = (c && c.window === window ? c.count : 0) + add;
    this.counters.set(key, { window, count });
    return count;
  }

  async putInvoice(doc: InvoiceDoc) {
    this.invoices.set(doc.id, clone(doc));
  }
  async getInvoice(id: number) {
    const d = this.invoices.get(id);
    return d ? clone(d) : null;
  }
  async listInvoices(owner: string) {
    return [...this.invoices.values()].filter((d) => d.owner === owner).map(clone);
  }
  async putPayment(rec: PaymentRecord) {
    this.payments.set(rec.depositAddress, clone(rec));
  }
  async getPayment(addr: string) {
    const r = this.payments.get(addr);
    return r ? clone(r) : null;
  }
  async listPayments(f?: PaymentFilter) {
    return [...this.payments.values()].filter((p) => matches(p, f)).map(clone);
  }
  async putBatch(doc: BatchDoc) {
    this.batches.set(doc.id, clone(doc));
  }
  async getBatch(id: number) {
    const d = this.batches.get(id);
    return d ? clone(d) : null;
  }
  async listBatches(owner?: string) {
    return [...this.batches.values()].filter((b) => owner === undefined || b.owner === owner).map(clone);
  }

  async putMerchant(m: Merchant) {
    this.merchants.set(m.id, clone(m));
  }
  async getMerchant(id: string) {
    const m = this.merchants.get(id);
    return m ? clone(m) : null;
  }
  async findMerchantByAccount(account: string) {
    const m = [...this.merchants.values()].find((x) => x.account === account);
    return m ? clone(m) : null;
  }
  async listMerchants() {
    return [...this.merchants.values()].map(clone);
  }
  async putApiKey(k: ApiKey) {
    this.keys.set(k.hash, clone(k));
  }
  async getApiKey(hash: string) {
    const k = this.keys.get(hash);
    return k ? clone(k) : null;
  }
  async putSession(s: CheckoutSessionRecord) {
    this.sessions.set(s.id, clone(s));
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? clone(s) : null;
  }
  async listSessions(merchantId: string, limit = 50) {
    return [...this.sessions.values()].filter((s) => s.merchantId === merchantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone);
  }
  async findSessionByIdempotencyKey(merchantId: string, key: string) {
    const s = [...this.sessions.values()].find((x) => x.merchantId === merchantId && x.idempotencyKey === key);
    return s ? clone(s) : null;
  }
  async putRefund(r: RefundRecord) {
    this.refunds.set(r.id, clone(r));
  }
  async getRefund(id: string) {
    const r = this.refunds.get(id);
    return r ? clone(r) : null;
  }
  async listRefunds(sessionId: string) {
    return [...this.refunds.values()].filter((r) => r.sessionId === sessionId).map(clone);
  }
  async listOpenRefunds() {
    return [...this.refunds.values()].filter((r) => r.status !== "succeeded" && r.status !== "failed").map(clone);
  }
  async findRefundByDeposit(dep: string) {
    const r = [...this.refunds.values()].find((x) => x.depositAddress === dep);
    return r ? clone(r) : null;
  }
  async getWebhook(id: string) {
    const w = this.hooks.get(id);
    return w ? clone(w) : null;
  }
  async putWebhook(w: WebhookDelivery) {
    this.hooks.set(w.id, clone(w));
  }
  async listDueWebhooks(nowIso: string) {
    return [...this.hooks.values()].filter((w) => w.status === "pending" && w.nextAttemptAt <= nowIso).map(clone);
  }
  async listWebhooks(merchantId: string) {
    return [...this.hooks.values()].filter((w) => w.merchantId === merchantId).map(clone);
  }
}
