/** Public shapes of the Cascade Checkout API (services/api). Amounts are USDC base units (6 decimals) as strings. */

export type SessionStatus = "open" | "processing" | "paid" | "expired";

export interface CheckoutSession {
  id: string; // cs_...
  object: "checkout.session";
  merchant: { name: string; account: string };
  amount: string;
  amountFormatted: string; // "12.50"
  currency: "USD";
  description: string;
  reference: string | null; // merchant's order id
  metadata: Record<string, string>;
  status: SessionStatus;
  url: string; // hosted checkout page
  successUrl: string | null;
  cancelUrl: string | null;
  payment: {
    depositAddress: string;
    depositMemo: string | null;
    asset: string;
    chain: string;
    amountIn: string;
    amountInFormatted: string;
    deadline: string;
    status: string; // 1Click status
  } | null;
  receipt: { id: number; nearTx: string | null; contract: string } | null;
  /** Revenue split this session pays into, if any. */
  split: { id: number; shares: { account: string; bps: number }[] } | null;
  /** The on-chain escrow this payment funds, if any (released to the merchant milestone by milestone). */
  escrowId: number | null;
  /** Where this payment settles: USDC on `chain` at `address` (null: USDC on NEAR to the merchant's account). */
  payout: { chain: string; address: string } | null;
  /** Cascade's fee in basis points, paid by the customer on top of `amount`. */
  feeBps: number;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
}

export interface CreateSessionParams {
  /** Dollars as a string ("12.50") or USDC base units as a bigint. */
  amount: string | bigint;
  description: string;
  reference?: string;
  metadata?: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
  /** Minutes until the session expires (default 60, max 1440). */
  expiresInMinutes?: number;
  /** Pay into a revenue split (create it once on-chain with create_split) instead of the merchant account. */
  splitId?: number;
  /** Fund an on-chain escrow (create_escrow, payee = you) instead; `amount` must equal its total. */
  escrowId?: number;
}

export type CheckoutEventType =
  | "checkout.session.completed"
  | "checkout.session.expired"
  | "checkout.payment.refunded"
  | "refund.succeeded"
  | "refund.failed";

export type BillingEventType =
  | "invoice.created"
  | "invoice.paid"
  | "invoice.overdue"
  | "invoice.voided"
  | "subscription.activated"
  | "subscription.renewed"
  | "subscription.past_due"
  | "subscription.canceled";

export type WebhookEventType = CheckoutEventType | BillingEventType;

export type WebhookEvent =
  | {
      id: string; // evt_...
      type: CheckoutEventType;
      created: string;
      data: { session: CheckoutSession; refundReason?: string; refund?: { id: string; amount: string; destTx: string | null } };
    }
  | {
      id: string;
      type: BillingEventType;
      created: string;
      data: { invoice?: Invoice; subscription?: Subscription };
    };

export interface Customer {
  name: string;
  email?: string;
}

export interface InvoiceItem {
  description: string;
  quantity: number;
  /** USDC base units per unit */
  unitAmount: string;
}

export interface Invoice {
  id: string; // in_...
  object: "invoice";
  number: string; // INV-0001, per merchant
  merchant: { name: string; account: string };
  customer: Customer;
  items: InvoiceItem[];
  amount: string; // USDC base units
  amountFormatted: string;
  currency: "USD";
  memo: string | null;
  status: "open" | "paid" | "void";
  overdue: boolean;
  dueDate: string; // YYYY-MM-DD
  url: string; // hosted invoice page
  sessionId: string | null; // the checkout session paying it, once the customer pressed Pay
  receipt: { id: number; nearTx: string | null } | null;
  subscriptionId: string | null;
  period: { start: string; end: string } | null;
  createdAt: string;
  paidAt: string | null;
}

export type Interval = "day" | "week" | "month" | "year";

export interface Plan {
  id: string; // plan_...
  object: "plan";
  name: string;
  amount: string; // per interval, USDC base units
  amountFormatted: string;
  interval: Interval;
  createdAt: string;
}

export interface Subscription {
  id: string; // sub_...
  object: "subscription";
  plan: Plan;
  customer: Customer;
  status: "incomplete" | "active" | "past_due" | "canceled";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  latestInvoiceId: string | null;
  createdAt: string;
  canceledAt: string | null;
}

export interface CustomerSummary extends Customer {
  invoices: number;
  paid: string; // USDC base units, lifetime
  outstanding: string;
  subscriptions: number;
  lastActivity: string;
}

export interface PayAsset {
  assetId: string;
  chain: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
  priceUsd: number;
}

export interface PaymentPreview {
  asset: PayAsset;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOut: string;
  timeEstimateSeconds: number;
}
