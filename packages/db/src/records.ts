import type { ExecutionStatus, QuoteResponse } from "@cascade/oneclick";

/** Off-chain invoice document. Its canonical-JSON hash is stored on-chain. */
export interface InvoiceDoc {
  id: number; // on-chain invoice id
  owner: string;
  amount: string; // USDC base units
  title: string;
  client: { name: string; email?: string };
  items: { description: string; quantity: number; unitPrice: string }[];
  dueDate?: string; // YYYY-MM-DD
  memo?: string;
  metadataHash: string;
  createdAt: string;
}

/** One 1Click order, incoming (someone pays an owner) or outgoing (a batch line). */
export interface PaymentRecord {
  depositAddress: string;
  direction: "in" | "out";
  owner: string;
  /** incoming: the invoice being paid, or null for a payment-link receipt */
  invoiceId: number | null;
  /** incoming: the checkout session this payment is for, if any */
  sessionId?: string | null;
  /** outgoing: which batch line this quote belongs to */
  batchId: number | null;
  lineIdx: number | null;
  /** who is on the other side, for the ledger */
  counterparty: string;
  originChain: string;
  destChain: string;
  quote: QuoteResponse;
  status: ExecutionStatus;
  /** settler has written this to the contract (incoming only) */
  recorded: boolean;
  nearTx: string | null;
  destTx: string | null;
  amountOut: string | null;
  refundReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchLineDoc {
  name: string;
  chain: string; // "near" or a 1Click chain id
  address: string; // NEAR account or address on `chain`
  amount: string; // USDC base units the recipient should get
  private: boolean;
  depositAddress: string | null; // set for quoted lines
}

export interface BatchDoc {
  id: number; // on-chain batch id
  owner: string;
  ownerKind: "Account" | "Dao";
  title: string;
  lines: BatchLineDoc[];
  proposalId: number | null;
  approvers: string[];
  createdAt: string;
}

export interface Merchant {
  id: string; // mrc_...
  account: string; // NEAR owner (person or DAO) that receives the USDC
  name: string;
  webhookUrl: string | null;
  webhookSecret: string; // whsec_...
  /** NEAR account that proved control when onboarding (the DAO's preparer, or the person) */
  verifiedBy: string;
  createdAt: string;
  /**
   * Where checkout payments settle: USDC on `chain` at `address`. Null: USDC on
   * NEAR in `account`. Changing it needs a signature from `account` (NEP-413).
   */
  payout?: Payout | null;
}

export interface Payout {
  chain: string;
  address: string;
}

export interface ApiKey {
  hash: string; // sha256 hex of the full key; the key itself is never stored
  prefix: string; // first 12 chars, for display
  merchantId: string;
  createdAt: string;
  revokedAt: string | null;
  /** "full" (default): everything. "read": GET requests only, e.g. for an accountant or a support tool. */
  role?: KeyRole;
  label?: string | null;
}

export type KeyRole = "full" | "read";

export type SessionState = "open" | "processing" | "paid" | "expired";

export interface CheckoutSessionRecord {
  id: string; // cs_...
  merchantId: string;
  owner: string;
  amount: string;
  description: string;
  reference: string | null;
  metadata: Record<string, string>;
  successUrl: string | null;
  cancelUrl: string | null;
  status: SessionState;
  /** deposit addresses of every payment attempt, newest last */
  attempts: string[];
  receiptId: number | null;
  nearTx: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  /** Revenue split (on-chain split id) this session pays into. */
  splitId?: number | null;
  /** On-chain escrow this session funds (1Click delivers into the contract with msg {"escrow": id}). */
  escrowId?: number | null;
  /** Payout destination when the session was created (null: USDC on NEAR to the owner). */
  payout?: Payout | null;
  /** x402: the "METHOD url" this session pays for, and when the payment was used. */
  x402Resource?: string | null;
  consumedAt?: string | null;
}

export type RefundState = "awaiting_batch" | "awaiting_funding" | "funded" | "succeeded" | "failed";

export interface RefundRecord {
  id: string; // rf_...
  sessionId: string;
  merchantId: string;
  owner: string;
  amount: string; // USDC base units the merchant sends
  depositAddress: string; // 1Click deposit address on NEAR that pays the customer back
  lines: { recipient: string; amount: string; kind: "CrossChain"; dest: string; deadline_ms: number }[];
  hash: string;
  status: RefundState;
  batchId: number | null;
  destTx: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string; // evt_...
  merchantId: string;
  type: string;
  body: string; // exact JSON that is signed and sent
  attempts: number;
  nextAttemptAt: string;
  status: "pending" | "delivered" | "failed";
  lastError: string | null;
  createdAt: string;
}

export interface PaymentFilter {
  owner?: string;
  direction?: "in" | "out";
  /** only records the settler still has work on */
  open?: boolean;
  batchId?: number;
}

export interface Store {
  putInvoice(doc: InvoiceDoc): Promise<void>;
  getInvoice(id: number): Promise<InvoiceDoc | null>;
  listInvoices(owner: string): Promise<InvoiceDoc[]>;

  putPayment(rec: PaymentRecord): Promise<void>;
  getPayment(depositAddress: string): Promise<PaymentRecord | null>;
  listPayments(f?: PaymentFilter): Promise<PaymentRecord[]>;

  putBatch(doc: BatchDoc): Promise<void>;
  getBatch(id: number): Promise<BatchDoc | null>;
  listBatches(owner?: string): Promise<BatchDoc[]>;

  putMerchant(m: Merchant): Promise<void>;
  getMerchant(id: string): Promise<Merchant | null>;
  findMerchantByAccount(account: string): Promise<Merchant | null>;
  listMerchants(): Promise<Merchant[]>;

  putApiKey(k: ApiKey): Promise<void>;
  getApiKey(hash: string): Promise<ApiKey | null>;

  putSession(s: CheckoutSessionRecord): Promise<void>;
  getSession(id: string): Promise<CheckoutSessionRecord | null>;
  listSessions(merchantId: string, limit?: number): Promise<CheckoutSessionRecord[]>;
  findSessionByIdempotencyKey(merchantId: string, key: string): Promise<CheckoutSessionRecord | null>;

  putRefund(r: RefundRecord): Promise<void>;
  getRefund(id: string): Promise<RefundRecord | null>;
  listRefunds(sessionId: string): Promise<RefundRecord[]>;
  findRefundByDeposit(depositAddress: string): Promise<RefundRecord | null>;
  /** Refunds still waiting for the merchant's funding or for delivery. */
  listOpenRefunds(): Promise<RefundRecord[]>;

  putWebhook(w: WebhookDelivery): Promise<void>;
  getWebhook(id: string): Promise<WebhookDelivery | null>;
  listDueWebhooks(nowIso: string): Promise<WebhookDelivery[]>;
  listWebhooks(merchantId: string): Promise<WebhookDelivery[]>;

  /**
   * Claims `key` until `now + ttlMs`. Resolves false if it is already claimed
   * and the claim has not expired. Used for one-time nonces and short leases
   * (one settler tick at a time), so it must be atomic.
   */
  claimOnce(key: string, ttlMs: number, now: number): Promise<boolean>;
  /**
   * Fixed-window counter for rate limits: adds `add` (default 1) to `key`'s
   * count in the window of `windowMs` containing `now`, and returns the count.
   */
  hit(key: string, windowMs: number, now: number, add?: number): Promise<number>;

  /**
   * Merchant-scoped documents by kind ("invoice", "plan", "subscription"...):
   * features added after the core tables, without a store method each.
   */
  putDoc<T>(kind: string, id: string, merchantId: string, doc: T): Promise<void>;
  getDoc<T>(kind: string, id: string): Promise<T | null>;
  /** Oldest first. Without `merchantId`: every merchant's (for background jobs). */
  listDocs<T>(kind: string, merchantId?: string): Promise<T[]>;
}

const TERMINAL = new Set<ExecutionStatus>(["SUCCESS", "REFUNDED", "FAILED"]);

/** Does the settler still need to look at this payment? */
export function isOpen(p: PaymentRecord): boolean {
  if (!TERMINAL.has(p.status)) return true;
  return p.direction === "in" && p.status === "SUCCESS" && !p.recorded;
}

export function matches(p: PaymentRecord, f: PaymentFilter = {}): boolean {
  return (
    (f.owner === undefined || p.owner === f.owner) &&
    (f.direction === undefined || p.direction === f.direction) &&
    (f.batchId === undefined || p.batchId === f.batchId) &&
    (f.open === undefined || isOpen(p) === f.open)
  );
}
