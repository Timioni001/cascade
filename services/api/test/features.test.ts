import { beforeEach, describe, expect, it } from "vitest";
import { hashLines, type Batch, type Invoice, type LineInput, type Owner, type SplitRule } from "@cascade/core";
import { MemoryStore } from "@cascade/db";
import { Checkout, Refunds, checkoutHooks, onboardingMessage, type OnboardingProof } from "@cascade/engine";
import type { Chain, TxResult } from "@cascade/near";
import { MemoryDriver, MockOneClick } from "@cascade/oneclick";
import { Cascade, fetchWithPayment, verifyWebhook, x402Guard, type CheckoutSession, type RefundInfo } from "@cascade/sdk";
import { Settler, type SettlerChain } from "@cascade/settler";
import { apiApp } from "../src/index.js";

let now = Date.parse("2026-11-05T12:00:00Z");
const ETH_BASE = "nep141:base.omft.near";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const APP = "app.cascade.near";

/** A fake contract: answers the views Checkout uses; tests set batches and splits directly. */
const chainState = {
  owners: { "shop.near": { id: "shop.near", kind: "Account", preparers: [], token: "usdc.near" } } as Record<string, Owner>,
  splits: new Map<number, SplitRule>(),
  batches: new Map<number, Batch>(),
  invoices: new Map<number, Invoice>(),
  lines: new Map<number, LineInput[]>(),
};
const fakeChain = {
  provider: {},
  view: async (_c: string, m: string, a: { id?: unknown }) => {
    if (m === "get_owner") return chainState.owners[a.id as string] ?? null;
    if (m === "get_split") return chainState.splits.get(a.id as number) ?? null;
    if (m === "get_batch") return chainState.batches.get(a.id as number) ?? null;
    if (m === "get_lines") return chainState.lines.get(a.id as number) ?? [];
    if (m === "get_invoice") return chainState.invoices.get(a.id as number) ?? null;
    if (m === "get_config") return { token: "usdc.near" };
    return null;
  },
} as unknown as Chain;

const ok = (hash: string, value?: unknown): TxResult => ({ hash, ok: true, value, events: [], logs: [] });

class FakeSettlerChain implements SettlerChain {
  n = 0;
  recorded = new Set<string>();
  async markInvoicePaid() {
    return ok("x");
  }
  async recordLinkPayment(owner: string, dep: string, amountOut: bigint, destTx: string, hash: string) {
    this.recorded.add(dep);
    const id = this.n++;
    chainState.invoices.set(id, {
      id, owner, amount: amountOut.toString(), status: "Paid", source: "Link", metadata_hash: hash, created_by: "settler", created_at_ms: now,
      settlement: { deposit_address: dep, amount_out: amountOut.toString(), dest_tx: destTx, settled_at_ms: now },
    });
    return ok(`tx${id}`, { id });
  }
  async isDepositRecorded(d: string) {
    return this.recorded.has(d);
  }
  async batch(id: number) {
    return chainState.batches.get(id) ?? null;
  }
  async lines(id: number) {
    return (chainState.lines.get(id) ?? []).map((l) => ({ ...l, status: "Sent" as const, note: null }));
  }
  async executeBatch() {
    return ok("exec");
  }
  async nextBatchId() {
    return 0;
  }
  async refundFailed() {
    return ok("refund");
  }
}

let store: MemoryStore;
let driver: MemoryDriver;
let oneclick: MockOneClick;
let checkout: Checkout;
let api: ReturnType<typeof apiApp>;
let settler: Settler;
let hooks: string[];
let cascade: Cascade;
let secret: string;

const verifyProof = async (p: OnboardingProof, message: string) => Buffer.from(p.signature, "base64").toString() === message;
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

beforeEach(async () => {
  now = Date.parse("2026-11-05T12:00:00Z");
  chainState.splits.clear();
  chainState.batches.clear();
  chainState.invoices.clear();
  chainState.lines.clear();
  store = new MemoryStore();
  driver = new MemoryDriver();
  oneclick = new MockOneClick({ driver, now: () => now, authenticated: true });
  checkout = new Checkout({ store, oneclick, chain: fakeChain, app: APP, publicUrl: "https://cascade.link", now: () => now, verifyProof, fee: { recipient: "fees.cascade.near", bps: 30 } });
  const refunds = new Refunds(checkout);
  api = apiApp({ checkout, refunds, dev: { oneclick } });
  hooks = [];
  const fakeFetch: typeof fetch = async (_u, init) => (hooks.push(String(init!.body)), new Response(""));
  settler = new Settler({ oneclick, store, chain: new FakeSettlerChain(), now: () => now, hooks: checkoutHooks(checkout, fakeFetch, refunds) });
  const issuedAt = new Date(now).toISOString();
  const r = await call("POST", "/v1/merchants", {
    account: "shop.near", name: "Oakline Ceramics", webhookUrl: "https://shop.example/hook",
    proof: { signer: "shop.near", publicKey: "ed25519:x", issuedAt, nonce: Buffer.alloc(32, 7).toString("base64"), signature: Buffer.from(onboardingMessage({ account: "shop.near", name: "Oakline Ceramics", issuedAt })).toString("base64") },
  });
  const j = (await r.json()) as { secretKey: string; webhookSecret: string };
  secret = j.webhookSecret;
  // The SDK talks to the in-memory API.
  cascade = new Cascade({ apiKey: j.secretKey, baseUrl: "http://api", fetch: async (u, i) => api.request(String(u).replace("http://api", ""), i) });
});

async function paidSession(extra: Record<string, unknown> = {}): Promise<CheckoutSession> {
  const s = await cascade.checkout.create({ amount: "25.00", description: "Poster", reference: "order-1", ...extra });
  await call("POST", `/v1/public/sessions/${s.id}/pay`, { assetId: ETH_BASE, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" });
  await call("POST", `/v1/public/dev/sessions/${s.id}/simulate-deposit`);
  await settler.tick();
  return cascade.checkout.retrieve(s.id);
}

describe("fees", () => {
  it("adds Cascade's fee for the payer; the merchant still receives exactly the amount", async () => {
    const s = await cascade.checkout.create({ amount: "100.00", description: "x" });
    expect(s.feeBps).toBe(30);
    const p = (await (await call("POST", `/v1/public/sessions/${s.id}/pay`, { assetId: USDC_BASE, refundTo: "0xabc0000000000000000000000000000000000000" })).json()) as CheckoutSession;
    const rec = (await store.getPayment(p.payment!.depositAddress))!;
    expect(rec.quote.quoteRequest.appFees).toEqual([{ recipient: "fees.cascade.near", fee: 30 }]);
    expect(rec.quote.quote.amountOut).toBe("100000000");
    expect(BigInt(rec.quote.quote.minAmountIn)).toBeGreaterThan(100_300_000n); // 0.3% + spread on top
  });
});

describe("revenue splits", () => {
  it("a split session pays the Cascade contract with msg {split}; others' splits are refused", async () => {
    chainState.splits.set(4, { id: 4, owner: "shop.near", shares: [{ account: "shop.near", bps: 7000 }, { account: "designer.near", bps: 3000 }], created_by: "shop.near", created_at_ms: 0 });
    chainState.splits.set(5, { id: 5, owner: "other.near", shares: [{ account: "other.near", bps: 10000 }], created_by: "other.near", created_at_ms: 0 });
    await expect(cascade.checkout.create({ amount: "1.00", description: "x", splitId: 5 })).rejects.toMatchObject({ status: 403 });
    await expect(cascade.checkout.create({ amount: "1.00", description: "x", splitId: 99 })).rejects.toMatchObject({ status: 400 });
    const s = await paidSession({ splitId: 4 });
    expect(s.split).toEqual({ id: 4, shares: [{ account: "shop.near", bps: 7000 }, { account: "designer.near", bps: 3000 }] });
    expect(driver.messages).toEqual([{ recipient: APP, amount: 25_000_000n, msg: '{"split":4}' }]);
    expect(s.status).toBe("paid");
  });
});

describe("refunds", () => {
  it("prepare -> merchant creates batch -> confirm checks it on-chain -> funding call -> delivered -> webhook", async () => {
    const s = await paidSession();
    const r: RefundInfo = await cascade.refunds.create(s.id, { amount: "10.00" });
    expect(r).toMatchObject({ status: "awaiting_batch", amount: "10000000" });
    expect(r.lines[0]!.dest).toBe("base:0x2527D02599Ba641c19FEa793cD0F167589a0f10D"); // back to the payer, on their chain
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ receiverId: APP, methodName: "create_batch" });
    await expect(cascade.refunds.create(s.id, { amount: "20.00" })).rejects.toMatchObject({ status: 400 }); // 10 + 20 > 25

    // A batch with different lines is rejected.
    const bad = [{ ...r.lines[0]!, amount: "1" }];
    chainState.batches.set(7, batch(7, "shop.near", hashLines(bad as LineInput[])));
    await expect(cascade.refunds.confirm(r.id, 7)).rejects.toMatchObject({ status: 409 });
    chainState.batches.set(8, batch(8, "mallory.near", r.hash));
    await expect(cascade.refunds.confirm(r.id, 8)).rejects.toMatchObject({ status: 403 });

    chainState.batches.set(9, batch(9, "shop.near", r.hash));
    chainState.lines.set(9, r.lines as LineInput[]);
    const confirmed = await cascade.refunds.confirm(r.id, 9);
    expect(confirmed.status).toBe("awaiting_funding");
    expect(confirmed.calls[0]).toMatchObject({ methodName: "ft_transfer_call", deposit: "1", args: { receiver_id: APP, msg: JSON.stringify({ batch_id: 9, hash: r.hash }) } });

    // Merchant funds; contract pays the deposit address; 1Click delivers.
    chainState.batches.set(9, { ...batch(9, "shop.near", r.hash), status: "Done" });
    driver.send(r.lines[0]!.recipient, BigInt(r.lines[0]!.amount));
    await settler.tick();
    const done = await cascade.refunds.retrieve(r.id);
    expect(done.status).toBe("succeeded");
    expect(done.destTx).toMatch(/^0x/);
    const ev = JSON.parse(hooks.at(-1)!) as { type: string; data: { refund: { id: string } } };
    expect(ev.type).toBe("refund.succeeded");
    expect(ev.data.refund.id).toBe(r.id);
  });

  it("only paid sessions of your own can be refunded", async () => {
    const s = await cascade.checkout.create({ amount: "1.00", description: "x" });
    await expect(cascade.refunds.create(s.id)).rejects.toMatchObject({ status: 409 });
  });
});

function batch(id: number, owner: string, hash: string): Batch {
  return {
    id, owner, hash, total: "0", line_count: 1, status: "Draft", cursor: 0, proposal_id: null, created_by: owner, created_at_ms: 0,
    buckets: { queued: "0", in_flight: "0", sent: "0", failed: "0", refunding: "0", refunded: "0" },
  };
}

describe("x402 for agents", () => {
  it("an agent pays a 402 with any chain and gets exactly one response per payment", async () => {
    const guard = x402Guard(cascade, { price: "0.10", description: "One forecast", assets: [USDC_BASE, ETH_BASE] });
    const server: typeof fetch = async (u, init) => {
      const g = await guard(new Request(String(u), init));
      return g.paid ? new Response("sunny", { headers: g.headers }) : g.response;
    };
    // The "network": settle runs while the agent polls.
    let paidTo = "";
    const agent = fetchWithPayment("https://shop.example/forecast", {}, {
      fetch: server,
      pollMs: 1,
      choose: (accepts) => accepts.find((a) => a.extra.symbol === "ETH")!,
      pay: async (req) => {
        expect(req.network).toBe("eip155:8453");
        expect(req.asset).toBe("native");
        paidTo = req.payTo;
        const r = await (await call("POST", `/v1/public/dev/deposits/${req.payTo}/simulate`)).json() as { txHash: string };
        void settler.tick();
        return r.txHash;
      },
    });
    const res = await agent;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sunny");
    const rec = (await store.getPayment(paidTo))!;
    expect(rec.quote.quoteRequest.refundType).toBe("INTENTS"); // no refund address given: refunds stay with the merchant on Intents
    // Replaying the same paid signature does not unlock a second response.
    const sessionId = rec.sessionId!;
    const replay = await cascade.x402.settle({ payload: { x402Version: 2, resource: { url: "u", description: "d" }, accepted: { scheme: "exact", network: "eip155:8453", amount: "1", asset: "native", payTo: paidTo, maxTimeoutSeconds: 1, extra: { provider: "cascade", sessionId, chain: "base", symbol: "ETH", decimals: 18, amountUsd: "0.1" } }, payload: { txHash: "0xabcdefabcdefabcdefabcdef" } }, resource: "GET https://shop.example/forecast" });
    expect(replay).toMatchObject({ success: false, errorReason: "already_used" });
    // ...and a payment for one resource cannot unlock another.
    const other = await cascade.x402.settle({ payload: { x402Version: 2, resource: { url: "u", description: "d" }, accepted: { scheme: "exact", network: "eip155:8453", amount: "1", asset: "native", payTo: paidTo, maxTimeoutSeconds: 1, extra: { provider: "cascade", sessionId, chain: "base", symbol: "ETH", decimals: 18, amountUsd: "0.1" } }, payload: { txHash: "0xabcdefabcdefabcdefabcdef" } }, resource: "GET https://shop.example/premium" });
    expect(other).toMatchObject({ success: false, errorReason: "resource_mismatch" });
  });
});

describe("receipts, reports, webhooks", () => {
  it("a public receipt proves the on-chain record matches the session", async () => {
    const s = await paidSession();
    const r = (await (await call("GET", `/v1/public/sessions/${s.id}/receipt`)).json()) as { hashMatches: boolean; depositMatches: boolean; onchain: Invoice };
    expect(r.hashMatches).toBe(true);
    expect(r.depositMatches).toBe(true);
    expect(r.onchain.status).toBe("Paid");
  });

  it("lists signed webhooks, retries them, and exports the ledger CSV", async () => {
    await paidSession();
    const auth = { authorization: `Bearer ${(cascade as unknown as { opts: { apiKey: string } }).opts.apiKey}` };
    const list = (await (await call("GET", "/v1/webhooks", undefined, auth)).json()) as { data: { id: string; type: string; status: string }[] };
    expect(list.data[0]).toMatchObject({ type: "checkout.session.completed", status: "delivered" });
    expect((await verifyWebhook(hooks[0]!, null, secret).catch((e: Error) => e.message))).toContain("missing");
    expect((await call("POST", `/v1/webhooks/${list.data[0]!.id}/retry`, {}, auth)).status).toBe(200);
    const csv = await cascade.reports.ledgerCsv("2026-11");
    expect(csv.split("\r\n")[0]).toMatch(/^date,direction,counterparty/);
    expect(csv).toContain("checkout order-1");
    expect((await call("GET", "/v1/reports/ledger.csv?month=nov", undefined, auth)).status).toBe(400);
  });
});
