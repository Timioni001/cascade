/**
 * Server-side client. Uses your secret key (sk_...): never ship it to a browser.
 *
 *   const cascade = new Cascade({ apiKey: process.env.CASCADE_SECRET_KEY! });
 *   const session = await cascade.checkout.create({ amount: "25.00", description: "Poster", reference: order.id });
 *   redirect(session.url);
 */
import type { CheckoutSession, CreateSessionParams, Customer, CustomerSummary, Interval, Invoice, Plan, Subscription } from "./types.js";
import type { X402PaymentPayload, X402PaymentRequired, X402Settlement } from "./x402.js";

export interface RefundInfo {
  id: string; // rf_...
  sessionId: string;
  amount: string;
  status: "awaiting_batch" | "awaiting_funding" | "funded" | "succeeded" | "failed";
  /** The single payout line the merchant's batch must contain (hash-locked). */
  lines: { recipient: string; amount: string; kind: "CrossChain"; dest: string; deadline_ms: number }[];
  hash: string;
  /** NEAR calls the merchant signs, in order (any NEAR wallet or key). */
  calls: { receiverId: string; methodName: string; args: Record<string, unknown>; deposit: string; gas: string }[];
  batchId: number | null;
  destTx: string | null;
}

export const DEFAULT_API_URL = "https://api.cascade.link";

export class CascadeApiError extends Error {
  override name = "CascadeApiError";
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface CascadeOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** "12.5" -> "12500000"; bigint passes through. */
export function toUnits(amount: string | bigint): string {
  if (typeof amount === "bigint") return amount.toString();
  const s = amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid amount: ${amount}`);
  const [w, f = ""] = s.split(".") as [string, string?];
  return (BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

export class Cascade {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: CascadeOptions) {
    if (!/^(sk|rk)_/.test(opts.apiKey ?? "")) throw new Error("Cascade: apiKey must be a secret key (sk_...) or a read-only key (rk_...)");
    this.base = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const r = await this.f(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!r.ok) throw new CascadeApiError(r.status, j.error?.message ?? r.statusText, j);
    return j as T;
  }

  readonly checkout = {
    /** Pass `idempotencyKey` (e.g. your order id) so a retried request cannot create two sessions. */
    create: (p: CreateSessionParams, opts: { idempotencyKey?: string } = {}) =>
      this.req<CheckoutSession>("POST", "/v1/checkout/sessions", { ...p, amount: toUnits(p.amount) }, opts.idempotencyKey),
    retrieve: (id: string) => this.req<CheckoutSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`),
    list: (opts: { limit?: number } = {}) => this.req<{ data: CheckoutSession[] }>("GET", `/v1/checkout/sessions?limit=${opts.limit ?? 20}`),
  };

  readonly refunds = {
    /** Prepare a refund to the customer, on the chain and in the coin they paid with. Default: the full amount. */
    create: (sessionId: string, p: { amount?: string | bigint } = {}) =>
      this.req<RefundInfo>("POST", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/refunds`, p.amount !== undefined ? { amount: toUnits(p.amount) } : {}),
    /** After signing `calls`: tell Cascade which batch funds the refund. It checks the batch on-chain. */
    confirm: (refundId: string, batchId: number) => this.req<RefundInfo>("POST", `/v1/refunds/${encodeURIComponent(refundId)}/confirm`, { batchId }),
    retrieve: (refundId: string) => this.req<RefundInfo>("GET", `/v1/refunds/${encodeURIComponent(refundId)}`),
  };

  readonly x402 = {
    prepare: (p: { price: string; description: string; resource: string; url: string; mimeType?: string; assets?: string[]; refundTo?: string }) =>
      this.req<X402PaymentRequired>("POST", "/v1/x402/prepare", { ...p, amount: toUnits(p.price) }),
    settle: (p: { payload: X402PaymentPayload; resource: string }) => this.req<X402Settlement>("POST", "/v1/x402/settle", p),
  };

  readonly reports = {
    /** Accountant CSV for a month ("2026-11") or everything. */
    ledgerCsv: async (month?: string) => {
      const r = await this.f(`${this.base}/v1/reports/ledger.csv${month ? `?month=${encodeURIComponent(month)}` : ""}`, { headers: { authorization: `Bearer ${this.opts.apiKey}` } });
      if (!r.ok) throw new CascadeApiError(r.status, r.statusText);
      return r.text();
    },
  };

  readonly merchant = {
    me: () => this.req<{ id: string; name: string; account: string; webhookUrl: string | null; payout: { chain: string; address: string } | null }>("GET", "/v1/merchant"),
    /**
     * Settle future payments as USDC on another chain (null: back to NEAR).
     * `proof` is a NEP-413 signature of payoutMessage(...) by the merchant's NEAR account.
     */
    setPayout: (payout: { chain: string; address: string } | null, proof: SignedProof) => this.req("POST", "/v1/merchant/payout", { payout, proof }),
    update: (p: { name?: string; webhookUrl?: string | null }) => this.req("POST", "/v1/merchant", p),
    /** Team access: issue a read-only key (rk_..., GET only) for an accountant or a support tool, or another full key. */
    keys: {
      create: (p: { role?: "read" | "full"; label?: string } = {}) => this.req<{ key: string; role: string; prefix: string }>("POST", "/v1/merchant/keys", p),
      list: () => this.req<{ data: { prefix: string; role: string; label: string | null; createdAt: string; revokedAt: string | null }[] }>("GET", "/v1/merchant/keys"),
      revoke: (prefix: string) => this.req("POST", `/v1/merchant/keys/${encodeURIComponent(prefix)}/revoke`, {}),
    },
  };

  /** Hosted invoices: line items, a due date, a pay page at invoice.url. Amounts in dollars ("12.50") or base units. */
  readonly invoices = {
    create: (p: { customer: Customer; items: { description: string; quantity?: number; unitAmount: string | bigint }[]; dueDate?: string; daysUntilDue?: number; memo?: string }) =>
      this.req<Invoice>("POST", "/v1/invoices", { ...p, items: p.items.map((i) => ({ ...i, quantity: i.quantity ?? 1, unitAmount: toUnits(i.unitAmount) })) }),
    retrieve: (id: string) => this.req<Invoice>("GET", `/v1/invoices/${encodeURIComponent(id)}`),
    list: () => this.req<{ data: Invoice[] }>("GET", "/v1/invoices"),
    void: (id: string) => this.req<Invoice>("POST", `/v1/invoices/${encodeURIComponent(id)}/void`, {}),
  };

  /** Recurring billing: a plan, then subscriptions that invoice every interval (or prepay several). */
  readonly plans = {
    create: (p: { name: string; amount: string | bigint; interval: Interval }) => this.req<Plan>("POST", "/v1/plans", { ...p, amount: toUnits(p.amount) }),
    list: () => this.req<{ data: Plan[] }>("GET", "/v1/plans"),
  };

  readonly subscriptions = {
    create: (p: { planId: string; customer: Customer; prepaidPeriods?: number }) => this.req<Subscription & { latestInvoice: Invoice }>("POST", "/v1/subscriptions", p),
    retrieve: (id: string) => this.req<Subscription>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`),
    list: () => this.req<{ data: Subscription[] }>("GET", "/v1/subscriptions"),
    cancel: (id: string, opts: { atPeriodEnd?: boolean } = {}) => this.req<Subscription>("POST", `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, opts),
  };

  readonly customers = {
    list: () => this.req<{ data: CustomerSummary[] }>("GET", "/v1/customers"),
  };
}

/** A NEP-413 signature (base64 fields), as produced by any NEAR wallet's signMessage. */
export interface SignedProof {
  signer: string;
  publicKey: string;
  signature: string;
  nonce: string;
  issuedAt: string;
}

/** The text a merchant signs (NEP-413, recipient "cascade-checkout") to change where its payments settle. */
export function payoutMessage(p: { account: string; payout: { chain: string; address: string } | null; issuedAt: string }): string {
  const to = p.payout ? `USDC on ${p.payout.chain} to ${p.payout.address}` : `USDC on near to ${p.account}`;
  return `Cascade Checkout payout\naccount: ${p.account}\nsettle: ${to}\nissued: ${p.issuedAt}`;
}
