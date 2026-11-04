/**
 * Cascade as an x402 v2 facilitator: agents pay for an HTTP resource with any
 * coin on any chain, the merchant receives exact USDC on NEAR.
 *
 * prepare: one checkout session per 402, bound to "METHOD url". One payment
 *          option per asset (max 3), each a fresh 1Click deposit address.
 * settle:  checks the payment belongs to that session and resource, nudges
 *          1Click with the tx hash, and returns success once the settler has
 *          recorded the delivery. A paid session unlocks exactly one response.
 */
import { CHAINS } from "@cascade/core";
import type { Merchant } from "@cascade/db";
import { CAIP2, type X402PaymentPayload, type X402PaymentRequired, type X402Requirement, type X402Settlement } from "@cascade/sdk";
import { Checkout, CheckoutError, type RefundRoute } from "./checkout.js";

export const X402_DEFAULT_ASSETS = ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"]; // USDC on Base
const MAX_OPTIONS = 3;

export interface PrepareParams {
  amount: string; // USDC base units
  description: string;
  resource: string; // "GET https://api.example/forecast"
  url: string;
  mimeType?: string;
  assets?: string[];
  /** The agent's own refund address (only used for assets on a chain where it is a valid address). */
  refundTo?: string;
}

export class AgentPayments {
  constructor(private readonly c: Checkout) {}

  private now() {
    return (this.c.cfg.now ?? Date.now)();
  }

  async prepare(m: Merchant, p: PrepareParams): Promise<X402PaymentRequired> {
    if (!/^[A-Z]+ https?:\/\/\S+$/.test(p.resource) || p.resource.length > 500) throw new CheckoutError(400, "resource must be 'METHOD https://...'");
    const assetIds = [...new Set(p.assets?.length ? p.assets : X402_DEFAULT_ASSETS)];
    if (assetIds.length > MAX_OPTIONS) throw new CheckoutError(400, `at most ${MAX_OPTIONS} assets`);
    const assets = await Promise.all(assetIds.map((id) => this.c.asset(id)));
    for (const a of assets) if (!CAIP2[a.chain]) throw new CheckoutError(400, `no CAIP-2 network known for ${a.chain}`);

    const created = await this.c.createSession(m, { amount: p.amount, description: p.description, metadata: { x402: "1" }, expiresInMinutes: 15 });
    await this.c.cfg.store.putSession({ ...created, x402Resource: p.resource });
    const accepts: X402Requirement[] = [];
    for (const a of assets) {
      const fmt = CHAINS[a.chain]?.address;
      const refund: RefundRoute =
        p.refundTo && fmt?.test(p.refundTo) ? { refundTo: p.refundTo, type: "ORIGIN_CHAIN" } : { refundTo: m.account, type: "INTENTS" };
      const rec = await this.c.reserve(await this.c.getSession(created.id), a, refund);
      const q = rec.quote.quote;
      accepts.push({
        scheme: "exact",
        network: CAIP2[a.chain]!,
        amount: q.amountIn,
        asset: a.contractAddress ?? "native",
        payTo: rec.depositAddress,
        maxTimeoutSeconds: Math.max(0, Math.floor((Date.parse(q.deadline ?? rec.quote.quoteRequest.deadline) - this.now()) / 1000)),
        extra: {
          provider: "cascade", sessionId: created.id, chain: a.chain, symbol: a.symbol, decimals: a.decimals, amountUsd: q.amountInUsd,
          ...(q.depositMemo ? { memo: q.depositMemo } : {}),
        },
      });
    }
    return {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: p.url, description: p.description, ...(p.mimeType ? { mimeType: p.mimeType } : {}) },
      accepts,
    };
  }

  async settle(m: Merchant, p: { payload: X402PaymentPayload; resource: string }): Promise<X402Settlement> {
    const fail = (errorReason: string, network = ""): X402Settlement => ({ success: false, transaction: "", network, errorReason });
    const pl = p.payload;
    if (pl?.x402Version !== 2 || pl.accepted?.scheme !== "exact" || typeof pl.accepted?.extra?.sessionId !== "string") return fail("invalid_payload");
    const network = pl.accepted.network;
    const txHash = pl.payload?.txHash;
    if (typeof txHash !== "string" || !/^(0x)?[0-9A-Za-z]{20,128}$/.test(txHash)) return fail("invalid_payload", network);
    let s;
    try {
      s = await this.c.getSession(pl.accepted.extra.sessionId);
    } catch {
      return fail("unknown_session", network);
    }
    if (s.merchantId !== m.id) return fail("unknown_session", network);
    if (s.x402Resource !== p.resource) return fail("resource_mismatch", network);
    if (!s.attempts.includes(pl.accepted.payTo)) return fail("unknown_pay_to", network);
    if (s.consumedAt) return fail("already_used", network);
    if (s.status === "expired") return fail("expired", network);

    if (s.status !== "paid") {
      const key = `${pl.accepted.payTo}:${txHash}`;
      if (await this.c.cfg.store.claimOnce(`x402-nudge:${key}`, 60 * 60_000, this.now())) {
        await this.c.cfg.oneclick.submitDeposit({ depositAddress: pl.accepted.payTo, txHash }).catch(() => undefined);
      }
      return fail("payment_pending", network);
    }

    // Paid: hand out exactly one success for this session.
    // The claim is atomic in the store, so two instances cannot both succeed.
    if (!(await this.c.cfg.store.claimOnce(`x402-used:${s.id}`, 365 * 24 * 3_600_000, this.now()))) return fail("already_used", network);
    const fresh = await this.c.getSession(s.id);
    await this.c.cfg.store.putSession({ ...fresh, consumedAt: new Date(this.now()).toISOString() });
    return { success: true, transaction: fresh.nearTx ?? "", network: `near:${this.c.cfg.chain.networkId}` };
  }
}
