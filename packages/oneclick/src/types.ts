/**
 * Types for the 1Click API v0, transcribed from
 * https://1click.chaindefuser.com/docs/v0/openapi.yaml (fetched 2026-11-03).
 * Only the fields Cascade uses are listed; unknown fields pass through.
 */
export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = DepositType;
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type Confidentiality = "public" | "basic" | "advanced";

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  slippageTolerance: number; // basis points
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  amount: string; // base units of origin (EXACT_INPUT) or destination (EXACT_OUTPUT)
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  deadline: string; // ISO
  depositMode?: "SIMPLE" | "MEMO";
  confidentiality?: Confidentiality;
  referral?: string;
  quoteWaitingTimeMs?: number;
  appFees?: { recipient: string; fee: number }[];
  sessionId?: string;
  /** HIGHLY EXPERIMENTAL in 1Click: deliver to NEAR with ft_transfer_call and this msg. */
  customRecipientMsg?: string;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export type ExecutionStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface TxDetails {
  hash: string;
  explorerUrl: string;
}

export interface SwapDetails {
  intentHashes: string[];
  nearTxHashes: string[];
  amountIn?: string;
  amountInFormatted?: string;
  amountInUsd?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  slippage?: number;
  originChainTxHashes: TxDetails[];
  destinationChainTxHashes: TxDetails[];
  refundedAmount?: string;
  refundedAmountFormatted?: string;
  refundReason?: string;
  depositedAmount?: string;
  withdrawFee?: string;
}

export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: ExecutionStatus;
  updatedAt: string;
  swapDetails: SwapDetails;
}

export interface SubmitDepositRequest {
  txHash: string;
  depositAddress: string;
  nearSenderAccount?: string;
  memo?: string;
}

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export const TERMINAL: ReadonlySet<ExecutionStatus> = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export function isTerminal(s: ExecutionStatus): boolean {
  return TERMINAL.has(s);
}

/** The three words users see. */
export type PlainStatus = "Pending" | "Paid" | "Refunded" | "Failed";

export function plainStatus(s: ExecutionStatus): PlainStatus {
  if (s === "SUCCESS") return "Paid";
  if (s === "REFUNDED") return "Refunded";
  if (s === "FAILED") return "Failed";
  return "Pending";
}
