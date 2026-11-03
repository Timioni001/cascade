import { hashDocument, type Batch, type Line } from "@cascade/core";
import type { PaymentRecord, Store } from "@cascade/db";
import type { TxResult } from "@cascade/near";
import { isTerminal, type OneClick, type StatusResponse } from "@cascade/oneclick";

/** The settler's view of the chain. `services/settler/src/chain.ts` implements it with near-api-js. */
export interface SettlerChain {
  markInvoicePaid(id: number, depositAddress: string, amountOut: bigint, destTx: string): Promise<TxResult>;
  recordLinkPayment(owner: string, depositAddress: string, amountOut: bigint, destTx: string, metadataHash: string): Promise<TxResult>;
  isDepositRecorded(depositAddress: string): Promise<boolean>;
  batch(id: number): Promise<Batch | null>;
  lines(id: number): Promise<Line[]>;
  executeBatch(id: number, limit: number): Promise<TxResult>;
  refundFailed(id: number): Promise<TxResult>;
}

export type SettlerEvent =
  | { type: "status"; depositAddress: string; direction: "in" | "out"; from: string; to: string }
  | { type: "recorded"; depositAddress: string; invoiceId: number | null; tx: string }
  | { type: "executed"; batchId: number; tx: string }
  | { type: "refunded"; batchId: number; tx: string }
  | { type: "error"; where: string; message: string };

/** Optional extensions (checkout uses these). Each must be idempotent. */
export interface SettlerHooks {
  /** Hash to bind into a link receipt; null for the default. */
  receiptHash?(rec: PaymentRecord): Promise<string | null>;
  /** An incoming payment was recorded on-chain. */
  recorded?(rec: PaymentRecord, receiptId: number | null, tx: string): Promise<void>;
  /** 1Click refunded an incoming payment to the payer. */
  refunded?(rec: PaymentRecord): Promise<void>;
  /** An outgoing (batch line) payment reached a terminal 1Click status. */
  outgoing?(rec: PaymentRecord): Promise<void>;
  /** Runs at the end of every tick (session expiry, webhook delivery...). */
  afterTick?(): Promise<void>;
}

export interface SettlerOptions {
  oneclick: OneClick;
  store: Store;
  chain: SettlerChain;
  linesPerCall?: number;
  now?: () => number;
  onEvent?: (e: SettlerEvent) => void;
  hooks?: SettlerHooks;
}

/**
 * The settler is a crank, not a custodian:
 * 1. incoming: poll 1Click for each open deposit address; when it reports
 *    SUCCESS, record the payment on the contract (the only trusted step);
 * 2. batches: push funded batches forward with execute_batch, and once no
 *    line is pending, return failed lines to the owner with refund_failed;
 * 3. outgoing: poll 1Click for each paid cross-chain line so the owner sees
 *    Paid or Refunded (1Click refunds go straight to the owner).
 * Every step is idempotent, so a crash or a second settler is harmless.
 */
export class Settler {
  private readonly limit: number;
  private readonly now: () => number;
  private buffer: SettlerEvent[] = [];

  constructor(private readonly o: SettlerOptions) {
    this.limit = o.linesPerCall ?? 8;
    this.now = o.now ?? Date.now;
  }

  private emit(e: SettlerEvent) {
    this.buffer.push(e);
    this.o.onEvent?.(e);
  }

  /** One pass over everything. Returns what happened. */
  async tick(): Promise<SettlerEvent[]> {
    this.buffer = [];
    await this.guard("incoming", () => this.settleIncoming());
    await this.guard("batches", () => this.crankBatches());
    await this.guard("outgoing", () => this.trackOutgoing());
    if (this.o.hooks?.afterTick) await this.guard("hooks", () => this.o.hooks!.afterTick!());
    return this.buffer;
  }

  private async guard(where: string, f: () => Promise<void>) {
    try {
      await f();
    } catch (e) {
      this.emit({ type: "error", where, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async refresh(p: PaymentRecord): Promise<{ rec: PaymentRecord; s: StatusResponse }> {
    const s = await this.o.oneclick.status(p.depositAddress);
    const d = s.swapDetails;
    const rec: PaymentRecord = {
      ...p,
      status: s.status,
      updatedAt: new Date(this.now()).toISOString(),
      amountOut: d.amountOut ?? p.amountOut,
      nearTx: d.nearTxHashes.at(-1) ?? p.nearTx,
      destTx: d.destinationChainTxHashes.at(-1)?.hash ?? p.destTx,
      refundReason: d.refundReason ?? p.refundReason,
    };
    if (s.status !== p.status) {
      this.emit({ type: "status", depositAddress: p.depositAddress, direction: p.direction, from: p.status, to: s.status });
    }
    await this.o.store.putPayment(rec);
    return { rec, s };
  }

  async settleIncoming() {
    for (const p of await this.o.store.listPayments({ direction: "in", open: true })) {
      const { rec } = isTerminal(p.status) ? { rec: p } : await this.refresh(p);
      if (rec.status === "REFUNDED" && p.status !== "REFUNDED") await this.o.hooks?.refunded?.(rec);
      if (rec.status !== "SUCCESS" || rec.recorded) continue;
      if (await this.o.chain.isDepositRecorded(rec.depositAddress)) {
        await this.o.store.putPayment({ ...rec, recorded: true });
        await this.o.hooks?.recorded?.(rec, null, rec.nearTx ?? "");
        continue;
      }
      const amountOut = BigInt(rec.amountOut ?? rec.quote.quote.amountOut);
      const destTx = rec.nearTx ?? rec.destTx ?? "";
      const r =
        rec.invoiceId !== null
          ? await this.o.chain.markInvoicePaid(rec.invoiceId, rec.depositAddress, amountOut, destTx)
          : await this.o.chain.recordLinkPayment(
              rec.owner, rec.depositAddress, amountOut, destTx,
              (await this.o.hooks?.receiptHash?.(rec)) ??
                hashDocument({ kind: "link", owner: rec.owner, payer: rec.counterparty, depositAddress: rec.depositAddress, correlationId: rec.quote.correlationId }),
            );
      if (!r.ok) {
        this.emit({ type: "error", where: `record ${rec.depositAddress}`, message: r.error ?? "failed" });
        continue;
      }
      await this.o.store.putPayment({ ...rec, recorded: true });
      const receiptId = (r.value as { id?: number } | undefined)?.id ?? rec.invoiceId;
      await this.o.hooks?.recorded?.(rec, receiptId ?? null, r.hash);
      this.emit({ type: "recorded", depositAddress: rec.depositAddress, invoiceId: rec.invoiceId, tx: r.hash });
    }
  }

  async crankBatches() {
    for (const doc of await this.o.store.listBatches()) {
      const b = await this.o.chain.batch(doc.id);
      if (!b || (b.status !== "Funded" && b.status !== "Executing")) continue;
      if (BigInt(b.buckets.queued) > 0n) {
        const r = await this.o.chain.executeBatch(b.id, this.limit);
        if (r.ok) this.emit({ type: "executed", batchId: b.id, tx: r.hash });
        else this.emit({ type: "error", where: `execute ${b.id}`, message: r.error ?? "failed" });
        continue;
      }
      const pending = BigInt(b.buckets.in_flight) + BigInt(b.buckets.refunding);
      if (pending === 0n && BigInt(b.buckets.failed) > 0n) {
        const r = await this.o.chain.refundFailed(b.id);
        if (r.ok) this.emit({ type: "refunded", batchId: b.id, tx: r.hash });
        else this.emit({ type: "error", where: `refund ${b.id}`, message: r.error ?? "failed" });
      }
    }
  }

  async trackOutgoing() {
    const byBatch = new Map<number, Line[]>();
    for (const p of await this.o.store.listPayments({ direction: "out", open: true })) {
      if (p.batchId === null || p.lineIdx === null) continue;
      if (!byBatch.has(p.batchId)) byBatch.set(p.batchId, await this.o.chain.lines(p.batchId));
      const line = byBatch.get(p.batchId)![p.lineIdx];
      // Only ask 1Click once the contract has actually paid the deposit address.
      if (line?.status !== "Sent") continue;
      const { rec } = await this.refresh(p);
      if (isTerminal(rec.status) && !isTerminal(p.status)) await this.o.hooks?.outgoing?.(rec);
    }
  }

  /** Run until `signal` aborts. */
  async run(intervalMs: number, signal?: AbortSignal) {
    while (!signal?.aborted) {
      await this.tick();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
