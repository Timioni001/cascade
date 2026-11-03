import { describe, expect, it } from "vitest";
import type { DelegateSummary } from "@cascade/near";
import { checkDelegate, RateLimiter, type RelayPolicyConfig } from "../src/index.js";

const T = 10n ** 12n;
const cfg: RelayPolicyConfig = {
  app: "app.cascade.near",
  usdc: "usdc.near",
  maxGas: 300n * T,
  maxTotalGas: 300n * T,
  isRegisteredDao: async (a) => a === "studio.sputnik-dao.near",
};
const d = (receiverId: string, calls: DelegateSummary["calls"], otherActions: string[] = []): DelegateSummary => ({
  senderId: "ada.cascade.near", receiverId, maxBlockHeight: 100n, publicKey: "ed25519:x", calls, otherActions,
});
const call = (method: string, args: unknown = {}, deposit = 0n, gas = 30n * T) => ({ method, args, deposit, gas });

describe("relay policy", () => {
  it("relays allowed app methods with no deposit", async () => {
    expect(await checkDelegate(d(cfg.app, [call("create_batch")]), cfg)).toEqual({ ok: true, kind: "app" });
    expect((await checkDelegate(d(cfg.app, [call("create_batch", {}, 1n)]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.app, [call("mark_invoice_paid")]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.app, [call("on_line_sent")]), cfg)).ok).toBe(false);
  });

  it("relays batch funding only into Cascade with exactly 1 yocto", async () => {
    expect((await checkDelegate(d(cfg.usdc, [call("ft_transfer_call", { receiver_id: cfg.app }, 1n)]), cfg)).ok).toBe(true);
    expect((await checkDelegate(d(cfg.usdc, [call("ft_transfer_call", { receiver_id: "evil.near" }, 1n)]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.usdc, [call("ft_transfer", { receiver_id: cfg.app }, 1n)]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.usdc, [call("ft_transfer_call", { receiver_id: cfg.app }, 2n)]), cfg)).ok).toBe(false);
  });

  it("relays proposals and votes only on registered DAOs", async () => {
    expect((await checkDelegate(d("studio.sputnik-dao.near", [call("act_proposal")]), cfg)).ok).toBe(true);
    expect((await checkDelegate(d("studio.sputnik-dao.near", [call("add_proposal", {}, 10n ** 23n)]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d("studio.sputnik-dao.near", [call("change_policy")]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d("random.sputnik-dao.near", [call("act_proposal")]), cfg)).ok).toBe(false);
  });

  it("refuses anything that is not a function call, unknown receivers and gas bombs", async () => {
    expect((await checkDelegate(d(cfg.app, [], ["transfer"]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d("wrap.near", [call("near_deposit")]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.app, [call("execute_batch", {}, 0n, 301n * T)]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.app, [call("execute_batch", {}, 0n, 200n * T), call("execute_batch", {}, 0n, 200n * T)]), cfg)).ok).toBe(false);
  });
});

describe("rate limiter", () => {
  it("allows max per window, then resets", () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    const rule = { max: 2, windowMs: 1000 };
    expect([l.take("k", rule), l.take("k", rule), l.take("k", rule)]).toEqual([true, true, false]);
    expect(l.take("other", rule)).toBe(true);
    t = 1000;
    expect(l.take("k", rule)).toBe(true);
  });
});
