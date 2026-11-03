/**
 * Merchant refunds: send a paid customer their money back, in the coin and on
 * the chain they paid with, through the same hash-locked batch contract that
 * runs payroll.
 *
 *   1. prepare   Cascade quotes USDC on NEAR -> customer's coin, to the
 *                customer's own refund address, and locks it as one line.
 *   2. merchant signs create_batch(owner, lines)      (their key)
 *   3. confirm   Cascade checks that batch on-chain (owner, hash) and returns
 *                the funding call
 *   4. merchant signs usdc.ft_transfer_call(...)      (their key)
 *   5. the settler pays the line; 1Click delivers; webhook refund.succeeded
 *
 * Cascade cannot refund on its own: funding always needs the merchant's
 * signature, and the destination is fixed before they sign.
 */
import { formatDest, hashLines, type LineInput } from "@cascade/core";
import type { Merchant, PaymentRecord, RefundRecord } from "@cascade/db";
import { outgoingQuote } from "@cascade/oneclick";
import type { RefundInfo } from "@cascade/sdk";
import { Checkout, CheckoutError, randomId } from "./checkout.js";

const TGAS = 10n ** 12n;
const REFUND_DEADLINE_MS = 24 * 3600 * 1000;

type Call = RefundInfo["calls"][number];

export class Refunds {
  constructor(private readonly c: Checkout) {}

  private get store() {
    return this.c.cfg.store;
  }

  private iso() {
    return new Date((this.c.cfg.now ?? Date.now)()).toISOString();
  }

  private usdc(): Promise<string> {
    return this.c.reader.config().then((cfg) => cfg.token);
  }

  async view(r: RefundRecord): Promise<RefundInfo> {
    const calls: Call[] = [];
    if (r.status === "awaiting_batch") {
      calls.push({ receiverId: this.c.cfg.app, methodName: "create_batch", args: { owner: r.owner, lines: r.lines }, deposit: "0", gas: (100n * TGAS).toString() });
    }
    if (r.status === "awaiting_funding" && r.batchId !== null) {
      calls.push({
        receiverId: await this.usdc(),
        methodName: "ft_transfer_call",
        args: { receiver_id: this.c.cfg.app, amount: r.lines[0]!.amount, msg: JSON.stringify({ batch_id: r.batchId, hash: r.hash }) },
        deposit: "1",
        gas: (100n * TGAS).toString(),
      });
    }
    return { id: r.id, sessionId: r.sessionId, amount: r.amount, status: r.status, lines: r.lines, hash: r.hash, calls, batchId: r.batchId, destTx: r.destTx };
  }

  async get(m: Merchant, id: string): Promise<RefundRecord> {
    const r = /^rf_[A-Za-z0-9]{10,40}$/.test(id) ? await this.store.getRefund(id) : null;
    if (!r || r.merchantId !== m.id) throw new CheckoutError(404, "no such refund");
    return r;
  }

  /** Step 1. `amount` defaults to the full session amount, minus earlier refunds that did not fail. */
  async prepare(m: Merchant, sessionId: string, amount?: string): Promise<RefundRecord> {
    const s = await this.c.getSession(sessionId);
    if (s.merchantId !== m.id) throw new CheckoutError(404, "no such checkout session");
    if (s.status !== "paid") throw new CheckoutError(409, "only paid sessions can be refunded");
    const paid = await this.c.paidAttempt(s);
    if (!paid) throw new CheckoutError(409, "no delivered payment found for this session");
    const qr = paid.quote.quoteRequest;
    if (qr.refundType !== "ORIGIN_CHAIN") throw new CheckoutError(409, "no refund address on file for this payment (agent paid without one)");

    const prior = (await this.store.listRefunds(s.id)).filter((r) => r.status !== "failed");
    const already = prior.reduce((t, r) => t + BigInt(r.amount), 0n);
    const want = amount !== undefined ? BigInt(amount) : BigInt(s.amount) - already;
    if (want <= 0n) throw new CheckoutError(409, "nothing left to refund");
    if (already + want > BigInt(s.amount)) throw new CheckoutError(400, "refunds cannot exceed the amount paid");

    // The customer gets back the coin they paid with, on their chain, at their refund address.
    const now = (this.c.cfg.now ?? Date.now)();
    const q = await this.c.cfg.oneclick.quote(
      outgoingQuote({ destAsset: qr.originAsset, recipient: qr.refundTo, owner: s.owner, mode: "sender_pays", amount: want, dry: false, now, deadlineMs: REFUND_DEADLINE_MS }),
    );
    const dep = q.quote.depositAddress;
    if (!dep || !q.quote.deadline) throw new CheckoutError(502, "1Click returned no deposit address");
    const line = { recipient: dep, amount: q.quote.amountIn, kind: "CrossChain" as const, dest: formatDest(paid.originChain, qr.refundTo), deadline_ms: Date.parse(q.quote.deadline) };
    const r: RefundRecord = {
      id: randomId("rf_"), sessionId: s.id, merchantId: m.id, owner: s.owner, amount: want.toString(), depositAddress: dep,
      lines: [line], hash: hashLines([line as LineInput]), status: "awaiting_batch", batchId: null, destTx: null,
      createdAt: this.iso(), updatedAt: this.iso(),
    };
    const rec: PaymentRecord = {
      depositAddress: dep, direction: "out", owner: s.owner, invoiceId: null, sessionId: s.id, batchId: null, lineIdx: 0,
      counterparty: `refund ${s.reference ?? s.id}`, originChain: "near", destChain: paid.originChain, quote: q, status: "PENDING_DEPOSIT",
      recorded: false, nearTx: null, destTx: null, amountOut: null, refundReason: null, createdAt: this.iso(), updatedAt: this.iso(),
    };
    await this.store.putPayment(rec);
    await this.store.putRefund(r);
    return r;
  }

  /** Step 3. The merchant created the batch: check it on-chain and hand back the funding call. */
  async confirm(m: Merchant, id: string, batchId: number): Promise<RefundRecord> {
    const r = await this.get(m, id);
    if (r.batchId !== null) {
      if (r.batchId !== batchId) throw new CheckoutError(409, "this refund is already linked to another batch");
      return r;
    }
    const b = Number.isInteger(batchId) && batchId >= 0 ? await this.c.reader.batch(batchId) : null;
    if (!b) throw new CheckoutError(404, "no such batch on-chain");
    if (b.owner !== r.owner) throw new CheckoutError(403, "that batch belongs to another owner");
    if (b.hash !== r.hash) throw new CheckoutError(409, "that batch does not contain exactly this refund");
    const funded = b.status !== "Draft" && b.status !== "Cancelled";
    const next: RefundRecord = { ...r, batchId, status: funded ? "funded" : "awaiting_funding", updatedAt: this.iso() };
    await this.store.putRefund(next);
    const rec = await this.store.getPayment(r.depositAddress);
    if (rec) await this.store.putPayment({ ...rec, batchId });
    const line = r.lines[0]!;
    await this.store.putBatch({
      id: batchId, owner: r.owner, ownerKind: "Account", title: `Refund ${r.id}`, proposalId: null, approvers: [], createdAt: this.iso(),
      lines: [{ name: rec?.counterparty ?? "refund", chain: rec?.destChain ?? "?", address: line.dest.split(":").slice(1).join(":"), amount: r.amount, private: false, depositAddress: r.depositAddress }],
    });
    return next;
  }

  /** Settler hook: an outgoing payment finished. Updates the refund and notifies the merchant. */
  async onOutgoing(rec: PaymentRecord): Promise<void> {
    const r = await this.store.findRefundByDeposit(rec.depositAddress);
    if (!r || r.status === "succeeded" || r.status === "failed") return;
    const ok = rec.status === "SUCCESS";
    const next: RefundRecord = { ...r, status: ok ? "succeeded" : "failed", destTx: rec.destTx, updatedAt: this.iso() };
    await this.store.putRefund(next);
    const s = await this.store.getSession(r.sessionId);
    if (s) await this.c.enqueue(s, ok ? "refund.succeeded" : "refund.failed", undefined, { id: r.id, amount: r.amount, destTx: rec.destTx });
  }

  /** Notice when the merchant funded the batch (settler crank sees it; this keeps the status honest). */
  async refreshFunding(): Promise<void> {
    for (const r of await this.store.listOpenRefunds()) {
      if (r.status !== "awaiting_funding" || r.batchId === null) continue;
      const b = await this.c.reader.batch(r.batchId);
      if (b && b.status !== "Draft" && b.status !== "Cancelled") await this.store.putRefund({ ...r, status: "funded", updatedAt: this.iso() });
    }
  }
}
