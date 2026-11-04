import { beforeEach, describe, expect, it } from "vitest";
import type { Owner } from "@cascade/core";
import { MemoryStore } from "@cascade/db";
import { Billing, Checkout, addInterval, checkoutHooks, onboardingMessage, type OnboardingProof } from "@cascade/engine";
import type { Chain, TxResult } from "@cascade/near";
import { MemoryDriver, MockOneClick } from "@cascade/oneclick";
import type { CustomerSummary, Invoice, Plan, Subscription, WebhookEvent } from "@cascade/sdk";
import { Settler, type SettlerChain } from "@cascade/settler";
import { apiApp } from "../src/index.js";

const DAY = 86_400_000;
let now = Date.parse("2026-11-04T12:00:00Z");
const ETH_BASE = "nep141:base.omft.near";
const owners: Record<string, Owner> = { "shop.near": { id: "shop.near", kind: "Account", preparers: [], token: "usdc" } };
const fakeChain = { view: async (_c: string, m: string, a: { id?: string }) => (m === "get_owner" ? owners[a.id!] ?? null : null), provider: {} } as unknown as Chain;
const verifyProof = async (p: OnboardingProof, message: string) => Buffer.from(p.signature, "base64").toString() === message;
const ok = (value?: unknown) => ({ hash: "tx", ok: true, value, events: [], logs: [] }) as unknown as TxResult;

class FakeChain implements SettlerChain {
  recorded = new Set<string>();
  n = 0;
  async markInvoicePaid() {
    return ok();
  }
  async recordLinkPayment(_o: string, dep: string) {
    this.recorded.add(dep);
    return ok({ id: this.n++ });
  }
  async isDepositRecorded(d: string) {
    return this.recorded.has(d);
  }
  async batch() {
    return null;
  }
  async lines() {
    return [];
  }
  async executeBatch() {
    return ok();
  }
  async nextBatchId() {
    return 0;
  }
  async refundFailed() {
    return ok();
  }
}

let api: ReturnType<typeof apiApp>;
let settler: Settler;
let events: WebhookEvent[];
let auth: Record<string, string>;

beforeEach(async () => {
  now = Date.parse("2026-11-04T12:00:00Z");
  const store = new MemoryStore();
  const oneclick = new MockOneClick({ driver: new MemoryDriver(), now: () => now });
  const checkout = new Checkout({ store, oneclick, chain: fakeChain, app: "app.cascade.near", publicUrl: "https://cascade.link", now: () => now, verifyProof });
  const billing = new Billing(checkout);
  api = apiApp({ checkout, billing, dev: { oneclick } });
  events = [];
  const hookFetch: typeof fetch = async (_u, init) => {
    events.push(JSON.parse(String(init!.body)) as WebhookEvent);
    return new Response("");
  };
  settler = new Settler({ oneclick, store, chain: new FakeChain(), now: () => now, hooks: checkoutHooks(checkout, hookFetch, undefined, billing) });
  const issuedAt = new Date(now).toISOString();
  const r = await call("POST", "/v1/merchants", {
    account: "shop.near", name: "Oakline Ceramics", webhookUrl: "https://shop.example/hooks",
    proof: { signer: "shop.near", publicKey: "ed25519:x", issuedAt, nonce: Buffer.alloc(32, 1).toString("base64"), signature: Buffer.from(onboardingMessage({ account: "shop.near", name: "Oakline Ceramics", issuedAt })).toString("base64") },
  });
  auth = { authorization: `Bearer ${((await r.json()) as { secretKey: string }).secretKey}` };
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

/** The customer opens the hosted invoice, presses Pay, pays in ETH on Base; the settler records it. */
async function payInvoice(id: string) {
  const { sessionId } = await json<{ sessionId: string }>(call("POST", `/v1/public/invoices/${id}/pay`));
  await call("POST", `/v1/public/sessions/${sessionId}/pay`, { assetId: ETH_BASE, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" });
  await call("POST", `/v1/public/dev/sessions/${sessionId}/simulate-deposit`);
  await settler.tick();
  return sessionId;
}
const types = () => events.map((e) => e.type);

describe("invoices", () => {
  it("numbered invoice with line items -> hosted page -> paid in any coin -> invoice.paid with the on-chain receipt", async () => {
    const r = await call("POST", "/v1/invoices", {
      customer: { name: "Fieldwork Café", email: "Orders@Fieldwork.example" },
      items: [{ description: "Stoneware mug", quantity: 24, unitAmount: "18000000" }, { description: "Shipping", quantity: 1, unitAmount: "35000000" }],
      daysUntilDue: 14, memo: "Thank you!",
    }, auth);
    expect(r.status).toBe(201);
    const inv = await json<Invoice>(r);
    expect(inv).toMatchObject({ number: "INV-0001", amount: "467000000", amountFormatted: "467.00", status: "open", dueDate: "2026-11-18", customer: { email: "orders@fieldwork.example" } });
    expect(inv.url).toBe(`https://cascade.link/i/${inv.id}`);

    const pub = await json<Invoice>(call("GET", `/v1/public/invoices/${inv.id}`));
    expect(pub).toMatchObject({ merchant: { name: "Oakline Ceramics" }, items: inv.items, status: "open" });
    // Pressing Pay twice reuses the same checkout session.
    const a = await json<{ sessionId: string }>(call("POST", `/v1/public/invoices/${inv.id}/pay`));
    const b = await json<{ sessionId: string }>(call("POST", `/v1/public/invoices/${inv.id}/pay`));
    expect(b.sessionId).toBe(a.sessionId);

    await payInvoice(inv.id);
    const paid = await json<Invoice>(call("GET", `/v1/invoices/${inv.id}`, undefined, auth));
    expect(paid).toMatchObject({ status: "paid", receipt: { id: 0 }, sessionId: a.sessionId });
    expect(types()).toEqual(["invoice.created", "checkout.session.completed", "invoice.paid"]);
    expect((await call("POST", `/v1/public/invoices/${inv.id}/pay`)).status).toBe(409);
    expect((await json<Invoice>(call("POST", "/v1/invoices", { customer: { name: "B" }, items: [{ description: "x", unitAmount: "1" }] }, auth))).number).toBe("INV-0002");
  });

  it("validates input, voids, and sends one overdue reminder", async () => {
    for (const bad of [
      { customer: { name: "" }, items: [{ description: "x", unitAmount: "1" }] },
      { customer: { name: "A", email: "nope" }, items: [{ description: "x", unitAmount: "1" }] },
      { customer: { name: "A" }, items: [] },
      { customer: { name: "A" }, items: [{ description: "x", unitAmount: "1.5" }] },
      { customer: { name: "A" }, items: [{ description: "x", quantity: 0, unitAmount: "1" }] },
      { customer: { name: "A" }, items: [{ description: "x", unitAmount: "1" }], dueDate: "soon" },
    ]) expect((await call("POST", "/v1/invoices", bad, auth)).status).toBe(400);

    const inv = await json<Invoice>(call("POST", "/v1/invoices", { customer: { name: "A" }, items: [{ description: "x", unitAmount: "5000000" }], daysUntilDue: 2 }, auth));
    const v = await json<Invoice>(call("POST", "/v1/invoices", { customer: { name: "B" }, items: [{ description: "y", unitAmount: "5000000" }] }, auth));
    expect((await json<Invoice>(call("POST", `/v1/invoices/${v.id}/void`, {}, auth))).status).toBe("void");
    expect((await call("POST", `/v1/public/invoices/${v.id}/pay`)).status).toBe(410);

    now += 3 * DAY;
    await settler.tick();
    await settler.tick();
    expect(types().filter((t) => t === "invoice.overdue")).toHaveLength(1);
    expect((await json<Invoice>(call("GET", `/v1/public/invoices/${inv.id}`))).overdue).toBe(true);
  });
});

describe("subscriptions", () => {
  async function plan(interval = "month", amount = "12000000") {
    return json<Plan>(call("POST", "/v1/plans", { name: "Mug of the month", amount, interval }, auth));
  }

  it("first invoice activates; renewal invoices are issued before each period ends; prepaid periods count", async () => {
    const p = await plan();
    expect(p).toMatchObject({ amountFormatted: "12.00", interval: "month" });
    const s = await json<Subscription & { latestInvoice: Invoice }>(call("POST", "/v1/subscriptions", { planId: p.id, customer: { name: "Ines", email: "ines@example.com" }, prepaidPeriods: 3 }, auth));
    expect(s).toMatchObject({ status: "incomplete", latestInvoice: { amount: "36000000", items: [{ quantity: 3, unitAmount: "12000000" }] } });

    await payInvoice(s.latestInvoice.id);
    let sub = await json<Subscription>(call("GET", `/v1/subscriptions/${s.id}`, undefined, auth));
    expect(sub.status).toBe("active");
    expect(sub.currentPeriodEnd).toBe(addInterval(sub.currentPeriodStart!, "month", 3)); // 3 months prepaid
    expect(types()).toContain("subscription.activated");

    // Nothing is due until 3 days before the prepaid period ends.
    now += 80 * DAY;
    await settler.tick();
    expect(types()).not.toContain("subscription.renewed");
    now = Date.parse(sub.currentPeriodEnd!) - 2 * DAY;
    await settler.tick();
    sub = await json<Subscription>(call("GET", `/v1/subscriptions/${s.id}`, undefined, auth));
    const renewal = await json<Invoice>(call("GET", `/v1/invoices/${sub.latestInvoiceId}`, undefined, auth));
    expect(renewal).toMatchObject({ amount: "12000000", status: "open", subscriptionId: s.id, period: { start: sub.currentPeriodEnd } });
    await settler.tick(); // no duplicate renewal
    expect((await json<{ data: Invoice[] }>(call("GET", "/v1/invoices", undefined, auth))).data).toHaveLength(2);

    // Paying it extends the period back to back.
    const prevEnd = sub.currentPeriodEnd!;
    await payInvoice(renewal.id);
    sub = await json<Subscription>(call("GET", `/v1/subscriptions/${s.id}`, undefined, auth));
    expect(sub).toMatchObject({ status: "active", currentPeriodStart: prevEnd, currentPeriodEnd: addInterval(prevEnd, "month", 1) });
    expect(types()).toContain("subscription.renewed");
  });

  it("unpaid renewal -> past_due -> canceled after the grace period; cancel at period end", async () => {
    const p = await plan("week", "3000000");
    const s = await json<Subscription & { latestInvoice: Invoice }>(call("POST", "/v1/subscriptions", { planId: p.id, customer: { name: "Ola" } }, auth));
    await payInvoice(s.latestInvoice.id);
    const end = Date.parse((await json<Subscription>(call("GET", `/v1/subscriptions/${s.id}`, undefined, auth))).currentPeriodEnd!);
    now = end - DAY;
    await settler.tick(); // renewal issued
    now = end + 1000;
    await settler.tick();
    expect((await json<Subscription>(call("GET", `/v1/subscriptions/${s.id}`, undefined, auth))).status).toBe("past_due");
    now = end + 8 * DAY;
    await settler.tick();
    const gone = await json<Subscription>(call("GET", `/v1/subscriptions/${s.id}`, undefined, auth));
    expect(gone.status).toBe("canceled");
    expect((await json<Invoice>(call("GET", `/v1/invoices/${gone.latestInvoiceId}`, undefined, auth))).status).toBe("void");
    expect(types()).toEqual(expect.arrayContaining(["subscription.past_due", "subscription.canceled", "invoice.voided"]));

    const s2 = await json<Subscription & { latestInvoice: Invoice }>(call("POST", "/v1/subscriptions", { planId: p.id, customer: { name: "Ola" } }, auth));
    await payInvoice(s2.latestInvoice.id);
    expect((await json<Subscription>(call("POST", `/v1/subscriptions/${s2.id}/cancel`, { atPeriodEnd: true }, auth))).cancelAtPeriodEnd).toBe(true);
    now += 8 * DAY;
    await settler.tick();
    expect((await json<Subscription>(call("GET", `/v1/subscriptions/${s2.id}`, undefined, auth))).status).toBe("canceled");
  });

  it("customers aggregate invoices and subscriptions", async () => {
    const p = await plan();
    const s = await json<Subscription & { latestInvoice: Invoice }>(call("POST", "/v1/subscriptions", { planId: p.id, customer: { name: "Ines", email: "ines@example.com" } }, auth));
    await payInvoice(s.latestInvoice.id);
    await call("POST", "/v1/invoices", { customer: { name: "Ines R.", email: "INES@example.com" }, items: [{ description: "Glaze workshop", unitAmount: "40000000" }] }, auth);
    const { data } = await json<{ data: CustomerSummary[] }>(call("GET", "/v1/customers", undefined, auth));
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ email: "ines@example.com", invoices: 2, paid: "12000000", outstanding: "40000000", subscriptions: 1 });
  });
});

describe("addInterval", () => {
  it("clamps month ends", () => {
    expect(addInterval("2026-01-31T10:00:00.000Z", "month", 1)).toBe("2026-02-28T10:00:00.000Z");
    expect(addInterval("2028-01-31T10:00:00.000Z", "month", 1)).toBe("2028-02-29T10:00:00.000Z");
    expect(addInterval("2026-11-30T00:00:00.000Z", "month", 3)).toBe("2027-02-28T00:00:00.000Z");
    expect(addInterval("2026-11-04T00:00:00.000Z", "year", 1)).toBe("2027-11-04T00:00:00.000Z");
    expect(addInterval("2026-11-04T00:00:00.000Z", "week", 2)).toBe("2026-11-18T00:00:00.000Z");
  });
});
