import { USDC_NEAR_ASSET } from "@cascade/core";
import type { QuoteRequest } from "./types.js";

/**
 * Cascade's rules for talking to 1Click, in one place.
 *
 * Money in:  payer's asset on any chain -> exactly `amountOut` USDC on NEAR,
 *            delivered straight to the owner (person or DAO). Refunds go back
 *            to the payer on their own chain.
 * Money out: USDC on NEAR -> recipient on their chain. The deposit address is
 *            a NEAR account the Cascade contract pays with ft_transfer.
 *            Refunds go to the batch OWNER on NEAR, not to the Cascade
 *            contract, so no refund ever has to be attributed by our backend.
 */

export const DEFAULT_SLIPPAGE_BPS = 100;
/** Long enough for a DAO vote. The settler re-quotes when this passes. */
export const OUTGOING_DEADLINE_MS = 72 * 3600 * 1000;
/** A payer has this long to send after confirming. */
export const INCOMING_DEADLINE_MS = 60 * 60 * 1000;

export interface IncomingQuoteParams {
  /** 1Click asset id the payer pays with, e.g. nep141:base.omft.near (ETH on Base). */
  payAsset: string;
  /** Owner account or DAO on NEAR that receives USDC. */
  owner: string;
  /** USDC base units the owner must receive. */
  amountOut: bigint;
  /** Payer's own address on the origin chain. Required for a real quote. */
  refundTo: string;
  dry: boolean;
  now?: number;
  slippageBps?: number;
  referral?: string;
  /** Override the payer's window (default 1 hour). */
  deadlineMs?: number;
  /** Where refunds go: the payer's address on their chain (default) or an account inside NEAR Intents. */
  refundType?: "ORIGIN_CHAIN" | "INTENTS";
  /** Deliver with ft_transfer_call(recipient, msg): used to pay into a Cascade revenue split. */
  recipientMsg?: string;
  /** Platform fee, paid by the payer on top of the exact output. */
  appFee?: { recipient: string; bps: number };
}

export function incomingQuote(p: IncomingQuoteParams): QuoteRequest {
  if (p.amountOut <= 0n) throw new Error("amount must be positive");
  return {
    dry: p.dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: p.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    originAsset: p.payAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_NEAR_ASSET,
    amount: p.amountOut.toString(),
    refundTo: p.refundTo,
    refundType: p.refundType ?? "ORIGIN_CHAIN",
    recipient: p.owner,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((p.now ?? Date.now()) + (p.deadlineMs ?? INCOMING_DEADLINE_MS)).toISOString(),
    ...(p.referral ? { referral: p.referral } : {}),
    ...(p.recipientMsg ? { customRecipientMsg: p.recipientMsg } : {}),
    ...(p.appFee && p.appFee.bps > 0 ? { appFees: [{ recipient: p.appFee.recipient, fee: p.appFee.bps }] } : {}),
  };
}

export interface OutgoingQuoteParams {
  /** 1Click asset id the recipient receives, e.g. USDC on Solana. */
  destAsset: string;
  /** Recipient's address on the destination chain. */
  recipient: string;
  /** Batch owner on NEAR: where 1Click refunds go if delivery fails. */
  owner: string;
  /** "recipient_gets": recipient receives exactly `amount` (EXACT_OUTPUT). "sender_pays": we send exactly `amount` (EXACT_INPUT). */
  mode: "recipient_gets" | "sender_pays";
  amount: bigint;
  /** Use Confidential Intents (needs a partner JWT). */
  private?: boolean;
  dry: boolean;
  now?: number;
  deadlineMs?: number;
  slippageBps?: number;
}

export function outgoingQuote(p: OutgoingQuoteParams): QuoteRequest {
  if (p.amount <= 0n) throw new Error("amount must be positive");
  return {
    dry: p.dry,
    swapType: p.mode === "recipient_gets" ? "EXACT_OUTPUT" : "EXACT_INPUT",
    slippageTolerance: p.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    originAsset: USDC_NEAR_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: p.destAsset,
    amount: p.amount.toString(),
    refundTo: p.owner,
    refundType: "ORIGIN_CHAIN",
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((p.now ?? Date.now()) + (p.deadlineMs ?? OUTGOING_DEADLINE_MS)).toISOString(),
    confidentiality: p.private ? "basic" : "public",
  };
}

/** How much USDC the contract must send to the deposit address for this quote. */
export function amountToSend(q: { quote: { amountIn: string } }): bigint {
  return BigInt(q.quote.amountIn);
}
