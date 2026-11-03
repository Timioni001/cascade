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
