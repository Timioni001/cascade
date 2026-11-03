import { beforeEach, describe, expect, it } from "vitest";
import type { Owner } from "@cascade/core";
import { MemoryStore } from "@cascade/db";
import { Checkout, checkoutHooks, onboardingMessage, type OnboardingProof } from "@cascade/engine";
import type { Chain, TxResult } from "@cascade/near";
import { MemoryDriver, MockOneClick } from "@cascade/oneclick";
import { verifyWebhook, type CheckoutSession, type WebhookEvent } from "@cascade/sdk";
import { Settler, type SettlerChain } from "@cascade/settler";
import { apiApp } from "../src/index.js";

let now = Date.parse("2026-11-04T12:00:00Z");
const ETH_BASE = "nep141:base.omft.near";

const owners: Record<string, Owner> = {
  "shop.near": { id: "shop.near", kind: "Account", preparers: [], token: "usdc" },
  "team.sputnik-dao.near": { id: "team.sputnik-dao.near", kind: "Dao", preparers: ["ada.near"], token: "usdc" },
};
const fakeChain = { view: async (_c: string, m: string, a: { id?: string }) => (m === "get_owner" ? owners[a.id!] ?? null : null), provider: {} } as unknown as Chain;

/** Accept a proof only if its "signature" is the base64 of the expected message: tests the plumbing, not ed25519. */
const verifyProof = async (p: OnboardingProof, message: string) => Buffer.from(p.signature, "base64").toString() === message;
function proof(account: string, name: string, signer = account, issuedAt = new Date(now).toISOString()): OnboardingProof {
  return {
    signer, publicKey: "ed25519:x", issuedAt,
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    signature: Buffer.from(onboardingMessage({ account, name, issuedAt })).toString("base64"),
  };
}

class FakeSettlerChain implements SettlerChain {
  recorded = new Set<string>();
  n = 0;
  async markInvoicePaid() {
    return { hash: "x", ok: false, value: undefined, events: [], logs: [] } as TxResult;
  }
  async recordLinkPayment(_o: string, dep: string) {
    this.recorded.add(dep);
    return { hash: `tx${this.n}`, ok: true, value: { id: this.n++ }, events: [], logs: [] } as TxResult;
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
    return { hash: "", ok: true, value: undefined, events: [], logs: [] } as TxResult;
  }
  async nextBatchId() {
    return 0;
  }
  async refundFailed() {
    return { hash: "", ok: true, value: undefined, events: [], logs: [] } as TxResult;
  }
}

let store: MemoryStore;
let oneclick: MockOneClick;
let checkout: Checkout;
let api: ReturnType<typeof apiApp>;
let settler: Settler;
let hooks: { status: number; body: string; sig: string | null }[];
let hookStatus: number;

beforeEach(() => {
  now = Date.parse("2026-11-04T12:00:00Z");
  store = new MemoryStore();
  oneclick = new MockOneClick({ driver: new MemoryDriver(), now: () => now });
  checkout = new Checkout({ store, oneclick, chain: fakeChain, app: "app.cascade.near", publicUrl: "https://cascade.link", now: () => now, verifyProof });
  api = apiApp({ checkout, dev: { oneclick } });
  hooks = [];
  hookStatus = 200;
  const fakeFetch: typeof fetch = async (_u, init) => {
    hooks.push({ status: hookStatus, body: String(init!.body), sig: (init!.headers as Record<string, string>)["Cascade-Signature"] ?? null });
    return new Response("", { status: hookStatus });
  };
  settler = new Settler({ oneclick, store, chain: new FakeSettlerChain(), now: () => now, hooks: checkoutHooks(checkout, fakeFetch) });
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function onboard(account = "shop.near", name = "Lagos Prints", signer = account) {
  const r = await call("POST", "/v1/merchants", { account, name, webhookUrl: "https://shop.example/hooks", proof: proof(account, name, signer) });
  return { status: r.status, body: (await r.json()) as { secretKey: string; webhookSecret: string; error?: { message: string } } };
}

describe("onboarding", () => {
  it("issues a secret key once and stores only its hash", async () => {
    const { status, body } = await onboard();
    expect(status).toBe(201);
    expect(body.secretKey).toMatch(/^sk_test_[A-Za-z0-9]{24}$/);
    expect(JSON.stringify(await store.getApiKey("nope"))).toBe("null");
    const me = await call("GET", "/v1/merchant", undefined, { authorization: `Bearer ${body.secretKey}` });
    expect(await me.json()).toMatchObject({ account: "shop.near", name: "Lagos Prints" });
  });

  it("a DAO's preparer can onboard the DAO; a stranger cannot", async () => {
    expect((await onboard("team.sputnik-dao.near", "Studio", "ada.near")).status).toBe(201);
    expect((await onboard("shop.near", "Mallory Shop", "mallory.near")).status).toBe(403);
  });

  it("refuses unregistered owners, bad signatures, stale proofs, replays and duplicates", async () => {
    expect((await onboard("nobody.near")).status).toBe(400);
    const bad = proof("shop.near", "Lagos Prints");
    bad.signature = Buffer.from("something else").toString("base64");
    expect((await call("POST", "/v1/merchants", { account: "shop.near", name: "Lagos Prints", proof: bad })).status).toBe(401);
    const stale = proof("shop.near", "Lagos Prints", "shop.near", new Date(now - 11 * 60_000).toISOString());
    expect((await call("POST", "/v1/merchants", { account: "shop.near", name: "Lagos Prints", proof: stale })).status).toBe(400);
    const p = proof("shop.near", "Lagos Prints");
    expect((await call("POST", "/v1/merchants", { account: "shop.near", name: "Lagos Prints", proof: p })).status).toBe(201);
    expect((await call("POST", "/v1/merchants", { account: "shop.near", name: "Lagos Prints", proof: p })).status).toBe(400); // replay
    expect((await onboard()).status).toBe(409);
  });

  it("rejects plain-http webhook URLs except localhost", async () => {
    const r = await call("POST", "/v1/merchants", { account: "shop.near", name: "Lagos Prints", webhookUrl: "http://evil.example/x", proof: proof("shop.near", "Lagos Prints") });
    expect(r.status).toBe(400);
  });
});

describe("sessions", () => {
  async function merchant() {
    const { body } = await onboard();
    return { auth: { authorization: `Bearer ${body.secretKey}` }, secret: body.webhookSecret };
  }

  it("needs a valid secret key, and keys are scoped to their merchant", async () => {
    expect((await call("POST", "/v1/checkout/sessions", { amount: "1", description: "x" })).status).toBe(401);
    expect((await call("POST", "/v1/checkout/sessions", { amount: "1", description: "x" }, { authorization: "Bearer sk_test_wrong" })).status).toBe(401);
    const a = await merchant();
    const s = (await (await call("POST", "/v1/checkout/sessions", { amount: "5000000", description: "Poster" }, a.auth)).json()) as CheckoutSession;
    const { body: other } = await onboard("team.sputnik-dao.near", "Studio", "ada.near");
    expect((await call("GET", `/v1/checkout/sessions/${s.id}`, undefined, { authorization: `Bearer ${other.secretKey}` })).status).toBe(404);
  });

  it("validates input and honours idempotency keys", async () => {
    const { auth } = await merchant();
    for (const bad of [{ amount: "0", description: "x" }, { amount: "1.5", description: "x" }, { amount: "1", description: "" }, { amount: "999999999999", description: "x" }]) {
      expect((await call("POST", "/v1/checkout/sessions", bad, auth)).status).toBe(400);
    }
    const h = { ...auth, "idempotency-key": "order-1" };
    const a = (await (await call("POST", "/v1/checkout/sessions", { amount: "5000000", description: "Poster" }, h)).json()) as CheckoutSession;
    const b = (await (await call("POST", "/v1/checkout/sessions", { amount: "5000000", description: "Poster" }, h)).json()) as CheckoutSession;
    expect(b.id).toBe(a.id);
    expect((await call("POST", "/v1/checkout/sessions", { amount: "6000000", description: "Poster" }, h)).status).toBe(409);
  });

  it("full flow: preview -> pay -> 1Click SUCCESS -> on-chain receipt -> signed webhook", async () => {
    const { auth, secret } = await merchant();
    const s = (await (await call("POST", "/v1/checkout/sessions", { amount: "25000000", description: "Poster", reference: "order-42" }, auth)).json()) as CheckoutSession;
    expect(s.url).toBe(`https://cascade.link/c/${s.id}`);

    const pub = (await (await call("GET", `/v1/public/sessions/${s.id}`)).json()) as CheckoutSession;
    expect(pub).toMatchObject({ status: "open", amountFormatted: "25.00", merchant: { name: "Lagos Prints" } });

    const prev = (await (await call("POST", `/v1/public/sessions/${s.id}/preview`, { assetId: ETH_BASE })).json()) as { amountOut: string; asset: { symbol: string } };
    expect(prev).toMatchObject({ amountOut: "25000000", asset: { symbol: "ETH" } });
    expect(oneclick.depositAddresses()).toHaveLength(0); // preview reserves nothing

    const paying = (await (await call("POST", `/v1/public/sessions/${s.id}/pay`, { assetId: ETH_BASE, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" })).json()) as CheckoutSession;
    expect(paying.payment).toMatchObject({ chain: "base", status: "PENDING_DEPOSIT" });

    await settler.tick();
    expect(hooks).toHaveLength(0);
    expect((await call("POST", `/v1/public/dev/sessions/${s.id}/simulate-deposit`)).status).toBe(200);
    await settler.tick();

    const done = (await (await call("GET", `/v1/checkout/sessions/${s.id}`, undefined, auth)).json()) as CheckoutSession;
    expect(done.status).toBe("paid");
    expect(done.receipt).toMatchObject({ id: 0, contract: "app.cascade.near" });
    expect(hooks).toHaveLength(1);
    const event = (await verifyWebhook(hooks[0]!.body, hooks[0]!.sig, secret, { now: Math.floor(now / 1000) })) as WebhookEvent;
    expect(event.type).toBe("checkout.session.completed");
    expect(event.data.session).toMatchObject({ id: s.id, reference: "order-42", status: "paid" });

    // Paid sessions cannot be paid again, and another tick sends nothing new.
    expect((await call("POST", `/v1/public/sessions/${s.id}/pay`, { assetId: ETH_BASE, refundTo: "0xabc" })).status).toBe(409);
    await settler.tick();
    expect(hooks).toHaveLength(1);
  });

  it("retries failed webhooks with backoff and gives up after 8 attempts", async () => {
    const { auth } = await merchant();
    const s = (await (await call("POST", "/v1/checkout/sessions", { amount: "1000000", description: "x" }, auth)).json()) as CheckoutSession;
    await call("POST", `/v1/public/sessions/${s.id}/pay`, { assetId: ETH_BASE, refundTo: "0xabc" });
    await call("POST", `/v1/public/dev/sessions/${s.id}/simulate-deposit`);
    hookStatus = 500;
    await settler.tick();
    expect(hooks).toHaveLength(1);
    await settler.tick(); // not due yet
    expect(hooks).toHaveLength(1);
    for (let i = 0; i < 12; i++) {
      now += 30 * 60_000;
      await settler.tick();
    }
    expect(hooks).toHaveLength(8);
    const [d] = await store.listWebhooks((await store.listMerchants())[0]!.id);
    expect(d).toMatchObject({ status: "failed", attempts: 8, lastError: "HTTP 500" });
  });

  it("refunds notify the merchant and keep the session open; idle sessions expire", async () => {
    const { auth } = await merchant();
    const s = (await (await call("POST", "/v1/checkout/sessions", { amount: "1000000", description: "x", expiresInMinutes: 10 }, auth)).json()) as CheckoutSession;
    const p = (await (await call("POST", `/v1/public/sessions/${s.id}/pay`, { assetId: ETH_BASE, refundTo: "0xabc" })).json()) as CheckoutSession;
    await oneclick.simulatePayerDeposit(p.payment!.depositAddress, { amount: 1n }); // underpaid -> refunded
    await settler.tick();
    expect(JSON.parse(hooks[0]!.body).type).toBe("checkout.payment.refunded");
    expect((await checkout.getSession(s.id)).status).toBe("open");
    now += 11 * 60_000;
    await settler.tick();
    expect((await checkout.getSession(s.id)).status).toBe("expired");
    expect(JSON.parse(hooks[1]!.body).type).toBe("checkout.session.expired");
    expect((await call("POST", `/v1/public/sessions/${s.id}/preview`, { assetId: ETH_BASE })).status).toBe(410);
  });

  it("public routes: unknown or malformed ids are 404, assets are listed", async () => {
    expect((await call("GET", "/v1/public/sessions/cs_doesnotexist000")).status).toBe(404);
    expect((await call("GET", "/v1/public/sessions/../../etc")).status).toBe(404);
    const a = (await (await call("GET", "/v1/public/assets")).json()) as { data: { symbol: string }[] };
    expect(a.data.map((x) => x.symbol)).toContain("ETH");
  });
});
