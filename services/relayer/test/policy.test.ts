import { describe, expect, it } from "vitest";
import type { DelegateSummary } from "@cascade/near";
import { fundBatchProposal, registerOwnerProposal } from "@cascade/sputnik";
import { checkDelegate, RateLimiter, type RelayPolicyConfig } from "../src/index.js";

const T = 10n ** 12n;
const cfg: RelayPolicyConfig = {
  app: "app.cascade.near",
  usdc: "usdc.near",
  maxGas: 300n * T,
  maxTotalGas: 300n * T,
  isRegisteredDao: async (a) => a === "studio.sputnik-dao.near",
  daoFactory: "sputnik-dao.near",
  // proposal 0 on newteam is a registration; proposal 1 is something else
  proposalKind: async (_dao, id) =>
    id === 0 ? registerOwnerProposal("app.cascade.near", []).kind : fundBatchProposal({ usdc: "usdc.near", cascade: "app.cascade.near", batch: { id: 1, hash: "h", total: "1", line_count: 1 } }).kind,
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

  it("onboards an unregistered DAO: only its register_owner proposal and votes", async () => {
    const reg = registerOwnerProposal(cfg.app, ["ada.near"]);
    const newDao = "newteam.sputnik-dao.near";
    expect(await checkDelegate(d(newDao, [call("add_proposal", { proposal: reg })]), cfg)).toEqual({ ok: true, kind: "dao-onboarding" });
    expect((await checkDelegate(d(newDao, [call("act_proposal", { id: 0, action: "VoteApprove", proposal: reg.kind })]), cfg)).ok).toBe(true);
    const other = fundBatchProposal({ usdc: cfg.usdc, cascade: cfg.app, batch: { id: 1, hash: "h", total: "1", line_count: 1 } });
    expect((await checkDelegate(d(newDao, [call("add_proposal", { proposal: other })]), cfg)).ok).toBe(false);
    // The vote's own `proposal` argument is ignored: what counts is what is stored.
    expect((await checkDelegate(d(newDao, [call("act_proposal", { id: 0, action: "VoteApprove", proposal: other.kind })]), cfg)).ok).toBe(true);
    expect((await checkDelegate(d(newDao, [call("act_proposal", { id: 1, action: "VoteApprove", proposal: reg.kind })]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d("notadao.near", [call("add_proposal", { proposal: reg })]), cfg)).ok).toBe(false);
  });

  it("refuses anything that is not a function call, unknown receivers and gas bombs", async () => {
    expect((await checkDelegate(d(cfg.app, [], ["transfer"]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d("wrap.near", [call("near_deposit")]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.app, [call("execute_batch", {}, 0n, 301n * T)]), cfg)).ok).toBe(false);
    expect((await checkDelegate(d(cfg.app, [call("execute_batch", {}, 0n, 200n * T), call("execute_batch", {}, 0n, 200n * T)]), cfg)).ok).toBe(false);
  });
});

describe("rate limiter", () => {
  it("allows max per window, then resets", async () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    const rule = { max: 2, windowMs: 1000 };
    expect([await l.take("k", rule), await l.take("k", rule), await l.take("k", rule)]).toEqual([true, true, false]);
    expect(await l.take("other", rule)).toBe(true);
    t = 1000;
    expect(await l.take("k", rule)).toBe(true);
  });
});
