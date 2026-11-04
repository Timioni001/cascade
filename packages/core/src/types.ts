/**
 * TypeScript mirror of the app contract's JSON types
 * (contracts/app/src/model.rs). u128 values travel as decimal strings.
 */
export type OwnerKind = "Account" | "Dao";

export interface Owner {
  id: string;
  kind: OwnerKind;
  preparers: string[];
  token: string;
}

export type InvoiceStatus = "Open" | "Paid" | "Void";
export type InvoiceSource = "Invoice" | "Link";

export interface Settlement {
  deposit_address: string;
  amount_out: string;
  dest_tx: string;
  settled_at_ms: number;
}

export interface Invoice {
  id: number;
  owner: string;
  amount: string;
  status: InvoiceStatus;
  source: InvoiceSource;
  metadata_hash: string;
  created_by: string;
  created_at_ms: number;
  settlement: Settlement | null;
}

export type LineKind = "Near" | "CrossChain" | "Private";

export interface LineInput {
  recipient: string;
  amount: string;
  kind: LineKind;
  dest: string | null;
  deadline_ms: number | null;
}

export type LineStatus = "Queued" | "InFlight" | "Sent" | "Failed" | "Refunding" | "Refunded";

export interface Line extends LineInput {
  status: LineStatus;
  note: string | null;
}

export type BatchStatus = "Draft" | "Funded" | "Executing" | "Done" | "PartlyRefunded" | "Cancelled";

export interface Buckets {
  queued: string;
  in_flight: string;
  sent: string;
  failed: string;
  refunding: string;
  refunded: string;
}

export interface Batch {
  id: number;
  owner: string;
  hash: string;
  total: string;
  line_count: number;
  status: BatchStatus;
  cursor: number;
  proposal_id: number | null;
  created_by: string;
  created_at_ms: number;
  buckets: Buckets;
}

export interface CreatedBatch {
  id: number;
  hash: string;
  total: string;
}

export interface AppConfig {
  admin: string;
  settler: string;
  token: string;
  dao_factory: string;
  storage_deposit: string;
  next_invoice_id: number;
  next_batch_id: number;
  next_split_id: number;
  next_escrow_id: number;
}

// ------------------------------------------------------------ escrow (mirrors contracts/app/src/vault.rs)

export interface MilestoneInput {
  title: string;
  amount: string; // USDC base units
}

export type MilestoneStatus = "Pending" | "Releasing" | "Released" | "Refunding" | "Refunded";

export interface Milestone {
  title: string;
  amount: string;
  status: MilestoneStatus;
}

export interface Escrow {
  id: number;
  payee: string;
  payer: string;
  arbiter: string | null;
  milestones: Milestone[];
  total: string;
  status: "AwaitingFunds" | "Funded" | "Closed" | "Cancelled";
  refund_after_ms: number;
  metadata_hash: string;
  created_by: string;
  created_at_ms: number;
  funded_by: string | null;
}

/** What the contract still holds for an escrow. */
export function escrowHeld(e: Escrow): bigint {
  if (e.status === "AwaitingFunds" || e.status === "Cancelled") return 0n;
  return e.milestones.filter((m) => m.status !== "Released" && m.status !== "Refunded").reduce((t, m) => t + BigInt(m.amount), 0n);
}

// ------------------------------------------------------------ agent allowances

export interface AllowancePolicy {
  per_payment_max: string;
  daily_max: string;
  expires_at_ms: number;
  /** Empty: any recipient. */
  payees: string[];
}

export interface Allowance {
  owner: string;
  agent: string;
  balance: string;
  policy: AllowancePolicy;
  day: number;
  spent_today: string;
  total_spent: string;
  payments: number;
  revoked: boolean;
  /** The mandate in the owner's words. */
  purpose: string;
  /** When the owner signed these limits. */
  authorized_at_ms: number;
}

/** A standing revenue split (shares in basis points, adding up to 10000). */
export interface Share {
  account: string;
  bps: number;
}

export interface SplitRule {
  id: number;
  owner: string;
  shares: Share[];
  created_by: string;
  created_at_ms: number;
}

/** The msg that pays into a split: usdc.ft_transfer_call(app, amount, JSON.stringify({ split: id })). */
export interface SplitMsg {
  split: number;
}

/** Mirror of the contract's split arithmetic: rounds down, remainder to the first share. */
export function splitAmount(amount: bigint, shares: readonly Share[]): bigint[] {
  const parts = shares.map((s) => (amount / 10_000n) * BigInt(s.bps) + ((amount % 10_000n) * BigInt(s.bps)) / 10_000n);
  const assigned = parts.reduce((a, b) => a + b, 0n);
  if (parts.length) parts[0] = parts[0]! + (amount - assigned);
  return parts;
}

export function validateShares(shares: readonly Share[]): string | null {
  if (shares.length === 0 || shares.length > 10) return "a split needs 1-10 shares";
  if (shares.some((s) => !Number.isInteger(s.bps) || s.bps <= 0)) return "every share must be above 0";
  if (new Set(shares.map((s) => s.account)).size !== shares.length) return "each account may appear once";
  if (shares.reduce((t, s) => t + s.bps, 0) !== 10_000) return "shares must add up to 10000 bps (100%)";
  return null;
}

/** The msg passed to usdc.ft_transfer_call to fund a batch. */
export interface FundMsg {
  batch_id: number;
  hash: string;
}

export const MAX_LINES = 50;
export const MAX_EXEC_PER_CALL = 8;

export function bucketSum(b: Buckets): bigint {
  return (
    BigInt(b.queued) + BigInt(b.in_flight) + BigInt(b.sent) + BigInt(b.failed) + BigInt(b.refunding) + BigInt(b.refunded)
  );
}
