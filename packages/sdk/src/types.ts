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
}

export type WebhookEventType =
  | "checkout.session.completed"
  | "checkout.session.expired"
  | "checkout.payment.refunded"
  | "refund.succeeded"
  | "refund.failed";

export interface WebhookEvent {
  id: string; // evt_...
  type: WebhookEventType;
  created: string;
  data: { session: CheckoutSession; refundReason?: string; refund?: { id: string; amount: string; destTx: string | null } };
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
