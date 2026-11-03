import { describe, expect, it } from "vitest";
import { buildEvmTransfer, Cascade, signWebhook, toUnits, verifyWebhook, WebhookVerificationError } from "../src/index.js";
import { isCheckoutMessage, payLink, sessionIdFromUrl } from "../src/browser.js";

describe("webhooks", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", created: "x", data: {} });
  it("round-trips and rejects tampering, wrong secret and replays", async () => {
    const t = 1_800_000_000;
    const h = await signWebhook("whsec_a", body, t);
    expect(h).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect((await verifyWebhook(body, h, "whsec_a", { now: t + 10 })).id).toBe("evt_1");
    await expect(verifyWebhook(body + " ", h, "whsec_a", { now: t })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhook(body, h, "whsec_b", { now: t })).rejects.toThrow("signature mismatch");
    await expect(verifyWebhook(body, h, "whsec_a", { now: t + 301 })).rejects.toThrow("tolerance");
    await expect(verifyWebhook(body, null, "whsec_a")).rejects.toThrow("missing");
  });
});

describe("evm", () => {
  it("encodes an ERC-20 transfer exactly", () => {
    const tx = buildEvmTransfer({ chain: "base", depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8", amount: 5_000_000n, tokenContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
    expect(tx.chainId).toBe(8453);
    expect(tx.to).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(tx.data).toBe("0xa9059cbb00000000000000000000000076b4c56085ed136a8744d52be956396624a730e800000000000000000000000000000000000000000000000000000000004c4b40");
    expect(tx.data.length).toBe(2 + 8 + 128);
  });
  it("sends native coin as value", () => {
    const tx = buildEvmTransfer({ chain: "eth", depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8", amount: "2215954324319037", tokenContract: null });
    expect(tx).toEqual({ chainId: 1, to: "0x76b4c56085ED136a8744D52bE956396624a730E8", value: "0x7df661256eb3d", data: "0x" });
  });
  it("refuses non-EVM chains and bad addresses", () => {
    expect(() => buildEvmTransfer({ chain: "sol", depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8", amount: 1n, tokenContract: null })).toThrow();
    expect(() => buildEvmTransfer({ chain: "base", depositAddress: "nope", amount: 1n, tokenContract: null })).toThrow();
  });
});

describe("client and helpers", () => {
  it("converts dollars to units", () => {
    expect(toUnits("12.5")).toBe("12500000");
    expect(toUnits(7n)).toBe("7");
    expect(() => toUnits("1.0000001")).toThrow();
  });
  it("refuses publishable or empty keys", () => {
    expect(() => new Cascade({ apiKey: "pk_x" })).toThrow();
  });
  it("sends the key, the idempotency key and dollar amounts as units", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const c = new Cascade({ apiKey: "sk_test_x", baseUrl: "http://api", fetch: async (url, init) => ((seen = { url: String(url), init: init! }), new Response("{}")) });
    await c.checkout.create({ amount: "25", description: "Poster" }, { idempotencyKey: "order-9" });
    const h = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe("http://api/v1/checkout/sessions");
    expect(h.authorization).toBe("Bearer sk_test_x");
    expect(h["idempotency-key"]).toBe("order-9");
    expect(JSON.parse(String(seen!.init.body)).amount).toBe("25000000");
  });
  it("parses session URLs and messages strictly", () => {
    expect(sessionIdFromUrl("https://cascade.link/c/cs_Ab12?embed=1")).toBe("cs_Ab12");
    expect(sessionIdFromUrl("https://cascade.link/c/../x")).toBe(null);
    expect(isCheckoutMessage({ source: "cascade-checkout", version: 1, type: "paid", sessionId: "cs_1" })).toBe(true);
    expect(isCheckoutMessage({ source: "cascade-checkout", version: 1, type: "steal", sessionId: "cs_1" })).toBe(false);
    expect(payLink("ada", { amount: "25" })).toBe("https://cascade.link/ada?amount=25");
  });
});
