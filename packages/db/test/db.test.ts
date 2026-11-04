import { describe, expect, it } from "vitest";
import { MockOneClick, incomingQuote } from "@cascade/oneclick";
import { readFileSync } from "node:fs";
import { MemoryStore, SCHEMA, SqliteStore, StoreLimiter, isOpen, ledgerRows, toCsv, type PaymentRecord, type Store } from "../src/index.js";

async function payment(): Promise<PaymentRecord> {
  const m = new MockOneClick({ now: () => Date.parse("2026-11-04T10:00:00Z") });
  const quote = await m.quote(incomingQuote({ payAsset: "nep141:base.omft.near", owner: "ada.near", amountOut: 300_000_000n, refundTo: "0xabc", dry: false, now: Date.parse("2026-11-04T10:00:00Z") }));
  return {
    depositAddress: quote.quote.depositAddress!, direction: "in", owner: "ada.near", invoiceId: 0, batchId: null, lineIdx: null,
    counterparty: "Berlin Studio GmbH", originChain: "base", destChain: "near", quote, status: "SUCCESS", recorded: true,
    nearTx: "NEARTX", destTx: "NEARTX", amountOut: "300000000", refundReason: null, createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-04T10:01:00.000Z",
  };
}

for (const [name, make] of [["memory", async () => new MemoryStore()], ["sqlite", () => SqliteStore.open(":memory:")]] as const) {
  describe(`${name} store`, () => {
    it("round-trips payments and filters open work", async () => {
      const s: Store = await make();
      const p = await payment();
      await s.putPayment(p);
      expect(await s.getPayment(p.depositAddress)).toEqual(p);
      expect(await s.listPayments({ open: true })).toHaveLength(0);
      await s.putPayment({ ...p, recorded: false });
      expect(await s.listPayments({ open: true })).toHaveLength(1);
      expect(await s.listPayments({ owner: "bob.near" })).toHaveLength(0);
    });

    it("keeps documents by kind and merchant, oldest first, updates in place", async () => {
      const s: Store = await make();
      await s.putDoc("invoice", "in_1", "m1", { n: 1 });
      await s.putDoc("invoice", "in_2", "m2", { n: 2 });
      await s.putDoc("invoice", "in_3", "m1", { n: 3 });
      await s.putDoc("plan", "in_1", "m1", { other: true });
      await s.putDoc("invoice", "in_1", "m1", { n: 10 });
      expect(await s.getDoc("invoice", "in_1")).toEqual({ n: 10 });
      expect(await s.listDocs("invoice", "m1")).toEqual([{ n: 10 }, { n: 3 }]);
      expect(await s.listDocs("invoice")).toHaveLength(3);
      expect(await s.getDoc("invoice", "nope")).toBeNull();
    });

    it("claims a key once until it expires (nonces, leases)", async () => {
      const s: Store = await make();
      expect(await s.claimOnce("n1", 1000, 0)).toBe(true);
      expect(await s.claimOnce("n1", 1000, 999)).toBe(false);
      expect(await s.claimOnce("n2", 1000, 999)).toBe(true);
      expect(await s.claimOnce("n1", 1000, 1000)).toBe(true); // expired: taken over
      expect(await s.claimOnce("n1", 1000, 1500)).toBe(false);
    });

    it("counts hits per fixed window; the limiter uses it", async () => {
      const s: Store = await make();
      expect([await s.hit("k", 100, 0), await s.hit("k", 100, 50), await s.hit("k", 100, 99, 0)]).toEqual([1, 2, 2]);
      expect(await s.hit("k", 100, 100)).toBe(1);
      let t = 0;
      const l = new StoreLimiter(s, () => t);
      const rule = { max: 2, windowMs: 1000 };
      expect([await l.take("a", rule), await l.take("a", rule), await l.peek("a", rule), await l.take("a", rule)]).toEqual([true, true, false, false]);
      t = 1000;
      expect(await l.peek("a", rule)).toBe(true);
    });
  });
}

describe("D1 migration", () => {
  it("is the same schema the Node store creates", () => {
    const sql = readFileSync(new URL("../../../services/worker/migrations/0001_init.sql", import.meta.url), "utf8");
    expect(sql.replace(/^--.*\n/gm, "").trim()).toBe(SCHEMA);
  });
});

describe("ledger", () => {
  it("writes a CSV an accountant can open", async () => {
    const s = new MemoryStore();
    await s.putPayment(await payment());
    await s.putBatch({
      id: 1, owner: "ada.near", ownerKind: "Account", title: "Rent", proposalId: null, approvers: [], createdAt: "2026-11-05T00:00:00.000Z",
      lines: [{ name: "=Landlord", chain: "sol", address: "So1", amount: "100000000", private: false, depositAddress: null }],
    });
    const rows = await ledgerRows(s, "ada.near", { month: "2026-11" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ direction: "in", net_usdc: "300.00", reference: "Invoice #0", status: "Paid", origin_chain: "base" });
    const csv = toCsv(rows);
    expect(csv.split("\r\n")[0]).toMatch(/^date,direction,counterparty/);
    expect(csv).toContain("'=Landlord"); // formula injection neutralised
    expect(await ledgerRows(s, "ada.near", { month: "2026-10" })).toHaveLength(0);
    expect(isOpen((await s.listPayments())[0]!)).toBe(false);
  });
});
