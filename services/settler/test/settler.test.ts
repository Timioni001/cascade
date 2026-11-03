import { describe, expect, it } from "vitest";
import type { Batch, Line } from "@cascade/core";
import { MemoryStore } from "@cascade/db";
import type { TxResult } from "@cascade/near";
import { MemoryDriver, MockOneClick, incomingQuote, outgoingQuote } from "@cascade/oneclick";
import { Settler, type SettlerChain } from "../src/index.js";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ok = (hash: string): TxResult => ({ hash, ok: true, value: undefined, events: [], logs: [] });

/** A fake contract that only tracks what the settler can see and do. */
class FakeChain implements SettlerChain {
  recorded = new Set<string>();
  calls: string[] = [];
  batches = new Map<number, Batch>();
  lineMap = new Map<number, Line[]>();
  async markInvoicePaid(id: number, dep: string) {
    if (this.recorded.has(dep)) return { ...ok("x"), ok: false, error: "deposit address already recorded" };
    this.recorded.add(dep);
    this.calls.push(`paid:${id}`);
    return ok(`tx-paid-${id}`);
  }
  async recordLinkPayment(owner: string, dep: string) {
    this.recorded.add(dep);
    this.calls.push(`link:${owner}`);
    return ok("tx-link");
  }
  async isDepositRecorded(dep: string) {
    return this.recorded.has(dep);
  }
  async batch(id: number) {
    return this.batches.get(id) ?? null;
  }
  async lines(id: number) {
    return this.lineMap.get(id) ?? [];
  }
  async executeBatch(id: number) {
    this.calls.push(`exec:${id}`);
    const b = this.batches.get(id)!;
    const ls = this.lineMap.get(id)!;
    for (const l of ls) l.status = l.recipient.includes("blocked") ? "Failed" : "Sent";
    const sum = (s: string) => ls.filter((l) => l.status === s).reduce((t, l) => t + BigInt(l.amount), 0n).toString();
    b.buckets = { ...b.buckets, queued: "0", sent: sum("Sent"), failed: sum("Failed") };
    b.status = "Executing";
    return ok(`tx-exec-${id}`);
  }
  /** Batches the contract created on its own (e.g. revenue splits) are found by scanning ids. */
  async nextBatchId() {
    return this.batches.size;
  }
  async refundFailed(id: number) {
    this.calls.push(`refund:${id}`);
    const b = this.batches.get(id)!;
    b.buckets = { ...b.buckets, refunded: b.buckets.failed, failed: "0" };
    b.status = "PartlyRefunded";
    return ok(`tx-refund-${id}`);
  }
}

function setup() {
  const driver = new MemoryDriver();
  const oneclick = new MockOneClick({ driver, now: () => NOW });
  const store = new MemoryStore();
  const chain = new FakeChain();
  const settler = new Settler({ oneclick, store, chain, now: () => NOW });
  return { driver, oneclick, store, chain, settler };
}

async function trackIncoming(s: ReturnType<typeof setup>, invoiceId: number | null) {
  const q = await s.oneclick.quote(incomingQuote({ payAsset: "nep141:base.omft.near", owner: "ada.near", amountOut: 5_000_000n, refundTo: "0xabc", dry: false, now: NOW }));
  await s.store.putPayment({
    depositAddress: q.quote.depositAddress!, direction: "in", owner: "ada.near", invoiceId, batchId: null, lineIdx: null,
    counterparty: "client", originChain: "base", destChain: "near", quote: q, status: "PENDING_DEPOSIT", recorded: false,
    nearTx: null, destTx: null, amountOut: null, refundReason: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  });
  return q.quote.depositAddress!;
}

describe("settler: incoming", () => {
  it("waits while pending, records once on SUCCESS, never twice", async () => {
    const s = setup();
    const dep = await trackIncoming(s, 7);
    expect(await s.settler.tick()).toEqual([]);
    await s.oneclick.simulatePayerDeposit(dep);
    const ev = await s.settler.tick();
    expect(ev.map((e) => e.type)).toEqual(["status", "recorded"]);
    expect(s.chain.calls).toEqual(["paid:7"]);
    expect((await s.store.getPayment(dep))!.recorded).toBe(true);
    expect(await s.settler.tick()).toEqual([]);
    expect(s.chain.calls).toEqual(["paid:7"]);
  });

  it("is idempotent across a crash between recording and saving", async () => {
    const s = setup();
    const dep = await trackIncoming(s, 1);
    await s.oneclick.simulatePayerDeposit(dep);
    s.chain.recorded.add(dep); // chain already has it, store does not know
    await s.settler.tick();
    expect(s.chain.calls).toEqual([]);
    expect((await s.store.getPayment(dep))!.recorded).toBe(true);
  });

  it("payment links become link receipts; refunds are not recorded", async () => {
    const s = setup();
    const link = await trackIncoming(s, null);
    const refunded = await trackIncoming(s, 2);
    await s.oneclick.simulatePayerDeposit(link);
    await s.oneclick.simulatePayerDeposit(refunded, { amount: 1n });
    await s.settler.tick();
    expect(s.chain.calls).toEqual(["link:ada.near"]);
    expect((await s.store.getPayment(refunded))!.status).toBe("REFUNDED");
  });
});

describe("settler: batches", () => {
  it("executes funded batches, then refunds failed lines once nothing is pending", async () => {
    const s = setup();
    const lines: Line[] = [
      { recipient: "bob.near", amount: "10", kind: "Near", dest: null, deadline_ms: null, status: "Queued", note: null },
      { recipient: "blocked.near", amount: "20", kind: "Near", dest: null, deadline_ms: null, status: "Queued", note: null },
    ];
    s.chain.lineMap.set(0, lines);
    s.chain.batches.set(0, {
      id: 0, owner: "ada.near", hash: "h", total: "30", line_count: 2, status: "Draft", cursor: 0, proposal_id: null, created_by: "ada.near", created_at_ms: 0,
      buckets: { queued: "30", in_flight: "0", sent: "0", failed: "0", refunding: "0", refunded: "0" },
    });
    await s.store.putBatch({ id: 0, owner: "ada.near", ownerKind: "Account", title: "t", lines: [], proposalId: null, approvers: [], createdAt: "" });
    await s.settler.tick();
    expect(s.chain.calls).toEqual([]); // draft: nothing to do
    s.chain.batches.get(0)!.status = "Funded";
    await s.settler.tick();
    await s.settler.tick();
    await s.settler.tick();
    expect(s.chain.calls).toEqual(["exec:0", "refund:0"]);
  });

  it("tracks a cross-chain line only after the contract paid it", async () => {
    const s = setup();
    const q = await s.oneclick.quote(outgoingQuote({ destAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", recipient: "Sol1", owner: "ada.near", mode: "recipient_gets", amount: 1_000_000n, dry: false, now: NOW }));
    const dep = q.quote.depositAddress!;
    await s.store.putPayment({
      depositAddress: dep, direction: "out", owner: "ada.near", invoiceId: null, batchId: 3, lineIdx: 0, counterparty: "landlord",
      originChain: "near", destChain: "sol", quote: q, status: "PENDING_DEPOSIT", recorded: false, nearTx: null, destTx: null,
      amountOut: null, refundReason: null, createdAt: "", updatedAt: "",
    });
    const line: Line = { recipient: dep, amount: q.quote.amountIn, kind: "CrossChain", dest: "sol:Sol1", deadline_ms: NOW + 1e6, status: "Queued", note: null };
    s.chain.lineMap.set(3, [line]);
    await s.settler.tick();
    expect((await s.store.getPayment(dep))!.status).toBe("PENDING_DEPOSIT");
    line.status = "Sent";
    s.driver.send(dep, BigInt(q.quote.amountIn));
    await s.settler.tick();
    const rec = (await s.store.getPayment(dep))!;
    expect(rec.status).toBe("SUCCESS");
    expect(rec.destTx).toMatch(/^0x/);
  });
});

describe("settler: discovery", () => {
  it("finds a funded batch the store never heard of (a revenue split payout) and pays it", async () => {
    const s = setup();
    const lines: Line[] = [{ recipient: "illustrator.near", amount: "15", kind: "Near", dest: null, deadline_ms: null, status: "Queued", note: null }];
    s.chain.lineMap.set(0, lines);
    s.chain.batches.set(0, {
      id: 0, owner: "shop.near", hash: "h", total: "15", line_count: 1, status: "Funded", cursor: 0, proposal_id: null, created_by: "intents.near", created_at_ms: 0,
      buckets: { queued: "15", in_flight: "0", sent: "0", failed: "0", refunding: "0", refunded: "0" },
    });
    const ev = await s.settler.tick();
    expect(ev.map((e) => e.type)).toEqual(["discovered", "executed"]);
    expect((await s.store.getBatch(0))!.owner).toBe("shop.near");
    expect(await s.settler.tick()).toEqual([]); // not discovered twice, nothing left to do
  });
});
