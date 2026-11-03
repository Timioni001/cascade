import { describe, expect, it } from "vitest";
import { USDC_NEAR_ASSET } from "@cascade/core";
import {
  HttpOneClick, MemoryDriver, MockOneClick, OneClickError, incomingQuote, outgoingQuote, plainStatus,
} from "../src/index.js";

const ETH_BASE = "nep141:base.omft.near";
const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const NOW = Date.parse("2026-11-04T12:00:00Z");

describe("Cascade quoting rules", () => {
  it("incoming: exact USDC out to the owner, refunds to the payer", () => {
    const q = incomingQuote({ payAsset: ETH_BASE, owner: "ada.cascade.near", amountOut: 5_000_000n, refundTo: "0xabc", dry: true, now: NOW });
    expect(q).toMatchObject({
      swapType: "EXACT_OUTPUT", destinationAsset: USDC_NEAR_ASSET, recipient: "ada.cascade.near",
      refundTo: "0xabc", refundType: "ORIGIN_CHAIN", depositType: "ORIGIN_CHAIN", amount: "5000000",
    });
    expect(Date.parse(q.deadline) - NOW).toBe(3_600_000);
  });

  it("outgoing: from USDC on NEAR, refunds to the owner, private uses confidentiality", () => {
    const q = outgoingQuote({ destAsset: USDC_SOL, recipient: "Sol1", owner: "studio.sputnik-dao.near", mode: "recipient_gets", amount: 1n, private: true, dry: false, now: NOW });
    expect(q).toMatchObject({ originAsset: USDC_NEAR_ASSET, swapType: "EXACT_OUTPUT", refundTo: "studio.sputnik-dao.near", confidentiality: "basic" });
    expect(Date.parse(q.deadline) - NOW).toBe(72 * 3_600_000);
  });
});

describe("MockOneClick", () => {
  it("dry quotes have no deposit address; real ones do", async () => {
    const m = new MockOneClick({ now: () => NOW });
    const req = incomingQuote({ payAsset: ETH_BASE, owner: "ada.near", amountOut: 5_000_000n, refundTo: "0xabc", dry: true, now: NOW });
    const dry = await m.quote(req);
    expect(dry.quote.depositAddress).toBeUndefined();
    expect(dry.quoteRequest.appFees?.[0]?.fee).toBe(20);
    const real = await m.quote({ ...req, dry: false });
    expect(real.quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(BigInt(real.quote.amountIn)).toBeGreaterThan(BigInt(real.quote.minAmountIn));
  });

  it("refuses confidential quotes without a JWT, like the real API", async () => {
    const q = outgoingQuote({ destAsset: USDC_SOL, recipient: "S", owner: "ada.near", mode: "sender_pays", amount: 1_000_000n, private: true, dry: true, now: NOW });
    await expect(new MockOneClick({ now: () => NOW }).quote(q)).rejects.toMatchObject({ status: 401 });
    await expect(new MockOneClick({ now: () => NOW, authenticated: true }).quote(q)).resolves.toBeTruthy();
  });

  it("incoming: deposit -> USDC delivered to the owner -> SUCCESS", async () => {
    const driver = new MemoryDriver();
    const m = new MockOneClick({ driver, now: () => NOW });
    const r = await m.quote(incomingQuote({ payAsset: ETH_BASE, owner: "ada.near", amountOut: 5_000_000n, refundTo: "0xabc", dry: false, now: NOW }));
    const addr = r.quote.depositAddress!;
    expect((await m.status(addr)).status).toBe("PENDING_DEPOSIT");
    const s = await m.simulatePayerDeposit(addr);
    expect(s.status).toBe("SUCCESS");
    expect(plainStatus(s.status)).toBe("Paid");
    expect(await driver.usdcBalance("ada.near")).toBe(5_000_000n);
    expect(s.swapDetails.nearTxHashes).toHaveLength(1);
  });

  it("incoming: underpayment is refunded", async () => {
    const m = new MockOneClick({ now: () => NOW });
    const r = await m.quote(incomingQuote({ payAsset: ETH_BASE, owner: "ada.near", amountOut: 5_000_000n, refundTo: "0xabc", dry: false, now: NOW }));
    const s = await m.simulatePayerDeposit(r.quote.depositAddress!, { amount: 1n });
    expect(s.status).toBe("REFUNDED");
    expect(s.swapDetails.refundReason).toBe("PARTIAL_DEPOSIT");
  });

  it("outgoing: watches the NEAR deposit address; late deposits are refunded to the owner", async () => {
    let now = NOW;
    const driver = new MemoryDriver();
    const m = new MockOneClick({ driver, now: () => now });
    const q = await m.quote(outgoingQuote({ destAsset: USDC_SOL, recipient: "Sol1", owner: "ada.near", mode: "recipient_gets", amount: 2_000_000n, dry: false, now, deadlineMs: 1000 }));
    const addr = q.quote.depositAddress!;
    expect(addr).toMatch(/^[0-9a-f]{64}$/);
    driver.send(addr, BigInt(q.quote.amountIn));
    expect((await m.status(addr)).status).toBe("SUCCESS");

    const late = await m.quote(outgoingQuote({ destAsset: USDC_SOL, recipient: "Sol2", owner: "ada.near", mode: "recipient_gets", amount: 2_000_000n, dry: false, now, deadlineMs: 1000 }));
    now += 5000;
    driver.send(late.quote.depositAddress!, BigInt(late.quote.amountIn));
    const s = await m.status(late.quote.depositAddress!);
    expect(s.status).toBe("REFUNDED");
    expect(await driver.usdcBalance("ada.near")).toBe(BigInt(late.quote.amountIn));
  });

  it("unknown deposit addresses are a 404", async () => {
    await expect(new MockOneClick().status("nope")).rejects.toBeInstanceOf(OneClickError);
  });
});

describe("HttpOneClick", () => {
  it("sends the JWT as a bearer token and surfaces API errors", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ message: "nope" }), { status: 400 });
    };
    const c = new HttpOneClick({ jwt: "secret", fetch: fake });
    await expect(c.status("abc")).rejects.toMatchObject({ status: 400, message: expect.stringContaining("nope") });
    expect(seen[0]!.url).toBe("https://1click.chaindefuser.com/v0/status?depositAddress=abc");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });
});
