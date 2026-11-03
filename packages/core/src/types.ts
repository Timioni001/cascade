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
