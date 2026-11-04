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

describe("payment URIs", () => {
  it("builds EIP-681 for native and ERC-20, Solana Pay and BIP-21", async () => {
    const { paymentUri, unitsToDecimal } = await import("../src/uris.js");
    const to = "0x76b4c56085ED136a8744D52bE956396624a730E8";
    expect(paymentUri({ chain: "base", depositAddress: to, amount: 2215954324319037n, decimals: 18, tokenContract: null })).toBe(`ethereum:${to}@8453?value=2215954324319037`);
    expect(paymentUri({ chain: "arb", depositAddress: to, amount: "5000000", decimals: 6, tokenContract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" })).toBe(
      `ethereum:0xaf88d065e77c8cc2239327c5edb3a432268e5831@42161/transfer?address=${to}&uint256=5000000`,
    );
    expect(paymentUri({ chain: "sol", depositAddress: "So1Addr", amount: 25_000_000n, decimals: 6, tokenContract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "Oakline Ceramics", message: "Stoneware mug" })).toBe(
      "solana:So1Addr?amount=25&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&label=Oakline%20Ceramics&message=Stoneware%20mug",
    );
    expect(paymentUri({ chain: "btc", depositAddress: "bc1qxyz", amount: 36_765n, decimals: 8, tokenContract: null })).toBe("bitcoin:bc1qxyz?amount=0.00036765");
    expect(paymentUri({ chain: "ton", depositAddress: "x", amount: 1n, decimals: 9, tokenContract: null })).toBeNull();
    expect(unitsToDecimal(1n, 18)).toBe("0.000000000000000001");
    expect(unitsToDecimal(100n, 2)).toBe("1");
  });
});

describe("x402", () => {
  it("encodes headers as base64 JSON, unicode-safe", async () => {
    const { encodeHeader, decodeHeader } = await import("../src/x402.js");
    const v = { a: "Mug — glazé €", n: 1 };
    expect(decodeHeader(encodeHeader(v))).toEqual(v);
  });

  it("guard -> 402 -> pay -> pending -> paid, end to end with a fake Cascade", async () => {
    const { x402Guard, fetchWithPayment, X402_HEADERS, decodeHeader } = await import("../src/x402.js");
    let settleCalls = 0;
    const fakeCascade = {
      x402: {
        prepare: async (p: { resource: string; refundTo?: string }) => ({
          x402Version: 2 as const, error: "PAYMENT-SIGNATURE header is required", resource: { url: p.resource, description: "forecast" },
          accepts: [{ scheme: "exact" as const, network: "eip155:8453", amount: "100000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0xdep", maxTimeoutSeconds: 300,
            extra: { provider: "cascade" as const, sessionId: "cs_1", chain: "base", symbol: "USDC", decimals: 6, amountUsd: "0.10" } }],
        }),
        settle: async (p: { payload: { payload: { txHash: string } } }) =>
          ++settleCalls < 2 ? { success: false, transaction: "", network: "eip155:8453", errorReason: "payment_pending" } : { success: true, transaction: `near:${p.payload.payload.txHash}`, network: "near:mainnet" },
      },
    };
    const guard = x402Guard(fakeCascade as never, { price: "0.10", description: "forecast" });
    const server: typeof fetch = async (url, init) => {
      const g = await guard(new Request(String(url), init));
      return g.paid ? new Response("sunny", { headers: g.headers }) : g.response;
    };
    const paid: string[] = [];
    const r = await fetchWithPayment("https://api.example/forecast", {}, { fetch: server, pollMs: 1, pay: async (req) => (paid.push(req.payTo), "0xtx") });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("sunny");
    expect(paid).toEqual(["0xdep"]);
    expect(decodeHeader<{ success: boolean }>(r.headers.get(X402_HEADERS.response)!).success).toBe(true);
    expect(settleCalls).toBe(2);
  });

  it("client refuses non-pending failures instead of looping", async () => {
    const { fetchWithPayment, encodeHeader } = await import("../src/x402.js");
    const required = { x402Version: 2, error: "", resource: { url: "u", description: "d" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1", asset: "a", payTo: "p", maxTimeoutSeconds: 1, extra: {} }] };
    let n = 0;
    const server: typeof fetch = async () =>
      n++ === 0
        ? new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader(required) } })
        : new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": encodeHeader({ success: false, transaction: "", network: "x", errorReason: "already_used" }) } });
    await expect(fetchWithPayment("u", {}, { fetch: server, pay: async () => "tx" })).rejects.toThrow("already_used");
  });
});
