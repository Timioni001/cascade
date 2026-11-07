/**
 * Sandbox tests: the safety rules, checked against real receipts on a local
 * NEAR node, with the real Sputnik DAO v2 contract and a mock USDC.
 *
 *   pnpm test:sandbox
 *
 * The same rules have unit tests in contracts/app/src/tests.rs; these prove
 * they also hold when promises, callbacks and other contracts are involved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bucketSum, parseUsd, type CreatedBatch, type Escrow } from "@cascade/core";
import { RelayError } from "@cascade/relayer";
import { expectOk } from "@cascade/engine";
import { appCalls, daoCalls, DaoReader, ftCalls } from "@cascade/near";
import { payrollPolicy, registerOwnerProposal, functionCallProposal } from "@cascade/sputnik";
import { createWorld, ids, type Person, type World } from "../../scripts/sandbox/world.js";
import { personalFlow, teamFlow, type PersonalResult, type TeamResult } from "../../scripts/sandbox/flows.js";
import { checkoutFlow, type CheckoutResult } from "../../scripts/sandbox/checkout-flow.js";
import { platformFlow, type PlatformResult } from "../../scripts/sandbox/platform-flow.js";
import { silent } from "../../scripts/sandbox/flows.js";
import { KeyPair } from "near-api-js";
import { ONBOARDING_RECIPIENT, onboardingMessage } from "@cascade/engine";

let w: World;
let personal: PersonalResult;
let team: TeamResult;
let shop: CheckoutResult;
let platform: PlatformResult;

beforeAll(async () => {
  w = await createWorld();
  personal = await personalFlow(w);
  team = await teamFlow(w, personal.ada);
  shop = await checkoutFlow(w, silent, { dao: team.dao });
  platform = await platformFlow(w, silent, shop);
});

afterAll(async () => {
  await w?.stop();
});

/** A fresh person with `usdc` dollars, registered as an owner. */
async function funded(name: string, usdc: string): Promise<Person> {
  const p = await w.signUp(name);
  await w.engine.registerPerson(p.gasless);
  await w.oneclick.driver.deliverUsdc(p.id, parseUsd(usdc));
  return p;
}

async function nearBatch(p: Person, to: string, amounts: string[]): Promise<CreatedBatch> {
  return w.engine.createBatch(p.gasless, {
    owner: p.id, title: "t",
    payees: amounts.map((a, i) => ({ name: `r${i}`, chain: "near", address: to, amount: parseUsd(a) })),
  });
}

describe("end-to-end stories (same as pnpm demo)", () => {
  it("personal: invoice paid from another chain, link receipt, split batch Done", () => {
    expect(personal.invoice.status).toBe("Paid");
    expect(personal.linkInvoice.source).toBe("Link");
    expect(personal.batch.status).toBe("Done");
    expect(personal.adaNearStart - personal.adaNearEnd).toBeLessThanOrEqual(1n);
  });

  it("team: real Sputnik DAO registers, funds after 2 of 3, failed line refunded", () => {
    expect(team.registerProposal.status).toBe("Approved");
    expect(team.fundedAfterOneVote.status).toBe("Draft");
    expect(team.fundProposal.status).toBe("Approved");
    expect(team.batch.status).toBe("PartlyRefunded");
    expect(team.lines.map((l) => l.status)).toEqual(["Sent", "Sent", "Sent", "Refunded"]);
    expect(team.approverNearAfter).toEqual(team.approverNearBefore);
  });
});

describe("rule 1: no line is paid before funding, and none is paid twice", () => {
  it("execute_batch on an unfunded batch fails and moves nothing", async () => {
    const p = await funded("rule1a", "10");
    const b = await nearBatch(p, "tunde.sandbox", ["1"]);
    const r = await w.chain.send(w.root, appCalls(ids.app).executeBatch(b.id));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("batch is not funded");
    expect((await w.engine.reader.lines(b.id))[0]!.status).toBe("Queued");
  });

  it("two cranks racing in the same block pay each line exactly once", async () => {
    const p = await funded("rule1b", "10");
    const kemiBefore = await w.usdcBalance("kemi.sandbox");
    const b = await nearBatch(p, "kemi.sandbox", ["1", "2", "3"]);
    expect((await p.gaslessFull(w.engine.fundCall(b))).ok).toBe(true);
    // Fire several execute_batch calls at once from different accounts.
    const crankers = [w.root, (await w.plainAccount("crank1")).full, (await w.plainAccount("crank2")).full];
    const results = await Promise.all(crankers.map((a) => w.chain.send<number>(a, appCalls(ids.app).executeBatch(b.id))));
    const dispatched = results.filter((r) => r.ok).reduce((n, r) => n + (r.value ?? 0), 0);
    expect(dispatched).toBe(3);
    const batch = (await w.engine.reader.batch(b.id))!;
    expect(batch.status).toBe("Done");
    expect(await w.usdcBalance("kemi.sandbox")).toBe(kemiBefore + parseUsd("6"));
    // Once Done, another crank cannot pay anything.
    const again = await w.chain.send(w.root, appCalls(ids.app).executeBatch(b.id));
    expect(again.ok).toBe(false);
  });
});

describe("rule 2: only the owner (or its DAO) can fund", () => {
  it("someone else's ft_transfer_call is returned in full", async () => {
    const owner = await funded("rule2a", "5");
    const mallory = await funded("rule2m", "5");
    const b = await nearBatch(owner, "tunde.sandbox", ["5"]);
    const before = await w.usdcBalance(mallory.id);
    const r = await mallory.gaslessFull(w.engine.fundCall(b));
    expect(r.ok).toBe(true); // the transfer itself ran...
    expect(r.value).toBe("0"); // ...and ft_transfer_call reports 0 used
    expect(await w.usdcBalance(mallory.id)).toBe(before);
    expect((await w.engine.reader.batch(b.id))!.status).toBe("Draft");
  });

  it("a DAO's preparer cannot fund the DAO's batch (from the team story)", () => {
    expect(team.preparerFundAttempt.adaUsdcAfter).toBe(team.preparerFundAttempt.adaUsdcBefore);
    expect(team.preparerFundAttempt.batchStatus).toBe("Draft");
  });

  it("an account outside the DAO factory cannot register as a Dao owner", async () => {
    const r = await w.chain.send(w.root, appCalls(ids.app).registerOwner("Dao", []));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Sputnik DAO");
  });
});

describe("rule 3: wrong amount or hash returns everything", () => {
  it("short amount, extra amount and wrong hash are each refunded in full", async () => {
    const p = await funded("rule3", "20");
    const b = await nearBatch(p, "tunde.sandbox", ["5"]);
    const before = await w.usdcBalance(p.id);
    const total = BigInt(b.total);
    for (const [amount, hash] of [[total - 1n, b.hash], [total + 1n, b.hash], [total, "00".repeat(32)]] as const) {
      const r = await p.gaslessFull(ftCalls(ids.usdc).fundBatch(ids.app, amount, { batch_id: b.id, hash }));
      expect(r.value).toBe("0");
      expect(await w.usdcBalance(p.id)).toBe(before);
    }
    expect((await w.engine.reader.batch(b.id))!.status).toBe("Draft");
    // The right amount and hash still work afterwards.
    expect((await p.gaslessFull(w.engine.fundCall(b))).value).toBe(total.toString());
    expect((await w.engine.reader.batch(b.id))!.status).toBe("Funded");
  });
});

describe("rule 4: Sent + Refunded + Queued always equals the total", () => {
  it("holds for every batch in this sandbox", async () => {
    const n = (await w.engine.reader.config()).next_batch_id;
    for (let id = 0; id < n; id++) {
      const b = (await w.engine.reader.batch(id))!;
      expect(bucketSum(b.buckets)).toBe(BigInt(b.total));
      const lines = await w.engine.reader.lines(id);
      const by = (s: string) => lines.filter((l) => l.status === s).reduce((t, l) => t + BigInt(l.amount), 0n);
      expect(by("Sent")).toBe(BigInt(b.buckets.sent));
      expect(by("Refunded")).toBe(BigInt(b.buckets.refunded));
      expect(by("Queued")).toBe(BigInt(b.buckets.queued));
      if (b.status === "Done" || b.status === "PartlyRefunded") {
        expect(BigInt(b.buckets.sent) + BigInt(b.buckets.refunded)).toBe(BigInt(b.total));
      }
    }
  });
});

describe("relayer and invoices", () => {
  it("the relayer refuses calls outside its allowlist", async () => {
    const p = await funded("relay1", "1");
    await expect(p.gaslessFull(ftCalls(ids.usdc).transfer("tunde.sandbox", 1n))).rejects.toBeInstanceOf(RelayError);
    await expect(p.gasless(appCalls(ids.app).markInvoicePaid(0, "x", 1n, "y"))).rejects.toThrow(/not relayed/);
  });

  it("only the settler can mark invoices paid, and each deposit counts once", async () => {
    const r = await w.chain.send(w.root, appCalls(ids.app).markInvoicePaid(0, "dep", 1n, "tx"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("only the settler");
    expect(await w.engine.reader.isDepositRecorded(personal.invoice.settlement!.deposit_address)).toBe(true);
  });

  it("names: taken names and reserved names are refused", async () => {
    await expect(w.signUp("ada")).rejects.toThrow(/taken/);
    await expect(w.signUp("relayer")).rejects.toThrow();
  });
});

describe("Sputnik v2 as deployed: a vote's `proposal` argument is not checked", () => {
  // Finding (2026-11-03): the Sputnik DAO v2 code on mainnet accepts an
  // act_proposal whose `proposal` argument differs from the stored proposal.
  // So the relayer must never trust that argument; it reads the stored kind.
  it("the DAO accepts a vote that lies about the proposal kind", async () => {
    const voters = [await w.plainAccount("v1"), await w.plainAccount("v2")];
    const dao = await w.createDao("checkdao", payrollPolicy({ finance: [voters[0]!.id], approvers: voters.map((v) => v.id), threshold: 2 }));
    const other = functionCallProposal("send something", ids.usdc, [{ method: "ft_transfer", args: { receiver_id: voters[0]!.id, amount: "1" }, deposit: 1n }]);
    const added = await w.chain.send<number>(voters[0]!.full, daoCalls(dao).addProposal(other));
    expect(added.ok).toBe(true);
    const id = added.value!;
    const lie = registerOwnerProposal(ids.app, []).kind;
    const r = await w.chain.send(voters[1]!.full, daoCalls(dao).act(id, "VoteApprove", lie));
    expect(r.ok).toBe(true);
    const p = await new DaoReader(w.chain, dao).proposal(id);
    expect(Object.keys(p.votes)).toEqual([voters[1]!.id]);

    // ...and the relayer refuses to pay for that same lying vote.
    const v3 = await w.plainAccount("v3");
    await expect(v3.gasless(daoCalls(dao).act(id, "VoteApprove", lie))).rejects.toThrow(/only its registration proposal/);
  });
});

describe("checkout (merchant API + SDK + webhooks, real chain)", () => {
  it("the shop is paid directly, gets a bound receipt and a verified webhook", () => {
    expect(shop.session.status).toBe("paid");
    expect(shop.merchantUsdcDelta).toBe(25_000_000n);
    expect(shop.cascadeHeldAnything).toBe(false);
    expect(shop.receiptHashMatches).toBe(true);
    expect(shop.webhook?.type).toBe("checkout.session.completed");
    expect(shop.webhookRejectedForgery).toBe(true);
  });

  it("a split payment is divided on arrival and paid out exactly, including to a DAO", () => {
    expect(shop.split.paid).toBe(true);
    shop.split.rule.shares.forEach((x, i) => expect(shop.split.received[x.account]).toBe(shop.split.expected[i]));
    expect(shop.split.rule.shares.map((x) => x.account)).toContain(team.dao);
  });

  it("a refund reaches the customer on their chain and notifies the merchant", () => {
    expect(shop.refund).toMatchObject({ status: "succeeded", amount: "10000000", webhookType: "refund.succeeded" });
    expect(shop.refund.destTx).toBeTruthy();
  });

  it("an agent pays over x402 once and cannot replay it", () => {
    expect(shop.agent.status).toBe(200);
    expect(shop.agent.settlement?.success).toBe(true);
    expect(shop.agent.replayStatus).toBe(402);
    expect(shop.agent.replayReason).toBe("already_used");
  });

  it("the contract refunds payments to an unknown split in full, and splits valid ones exactly", async () => {
    const payer = await funded("split-payer", "10");
    const before = await w.usdcBalance(payer.id);
    const bad = await payer.gaslessFull(ftCalls(ids.usdc).payToSplit(ids.app, parseUsd("1"), 999));
    expect(bad.value).toBe("0"); // ft_transfer_call reports 0 used: everything came back
    expect(await w.usdcBalance(payer.id)).toBe(before);
    const n0 = (await w.engine.reader.config()).next_batch_id;
    const ok = await payer.gaslessFull(ftCalls(ids.usdc).payToSplit(ids.app, parseUsd("1"), shop.split.rule.id));
    expect(ok.value).toBe("1000000");
    const b = (await w.engine.reader.batch(n0))!;
    expect(b).toMatchObject({ status: "Funded", owner: shop.split.rule.owner, total: "1000000" });
    expect((await w.engine.reader.lines(n0)).map((l) => l.amount)).toEqual(["800000", "150000", "50000"]);
  });

  async function onboardWith(account: string, signer: { signNep413Message: (a: { message: string; recipient: string; nonce: Uint8Array }) => Promise<{ publicKey: { toString(): string }; signature: Uint8Array }> }, signerId = account) {
    const issuedAt = new Date().toISOString();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const sig = await signer.signNep413Message({ message: onboardingMessage({ account, name: "Shop", issuedAt }), recipient: ONBOARDING_RECIPIENT, nonce });
    return fetch(`${w.apiUrl}/v1/merchants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, name: "Shop", proof: { signer: signerId, publicKey: sig.publicKey.toString(), signature: Buffer.from(sig.signature).toString("base64"), nonce: Buffer.from(nonce).toString("base64"), issuedAt } }),
    });
  }

  it("NEP-413 onboarding fails with a key the account does not have", async () => {
    const victim = await funded("victim-shop", "0");
    const stranger = w.chain.account(victim.id, KeyPair.fromRandom("ed25519")); // claims to be victim, wrong key
    expect((await onboardWith(victim.id, stranger)).status).toBe(401);
    expect((await onboardWith(victim.id, victim.full)).status).toBe(201);
  });

  it("a DAO preparer can onboard the DAO as a merchant", async () => {
    expect((await onboardWith(team.dao, personal.ada.full, personal.ada.id)).status).toBe(201);
  });
});

describe("merchant platform: payout preference, invoices, subscriptions", () => {
  it("a Base payout needs the account's signature and settles on Base, with a receipt on NEAR", () => {
    expect(platform.payout.refusedWithoutSignature).toBe(true);
    expect(platform.payout).toMatchObject({ recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", nearUsdcDelta: 0n, paid: true, receiptRecorded: true, back: true });
  });

  it("an invoice and a prepaid subscription are paid through checkout", () => {
    expect(platform.invoice).toMatchObject({ status: "paid", amount: "467000000" });
    expect(platform.invoice.events).toEqual(expect.arrayContaining(["invoice.created", "invoice.paid", "checkout.session.completed"]));
    expect(platform.subscription.status).toBe("active");
  });
});

describe("escrow: the contract holds the money between milestones", () => {
  it("funded through checkout; only the payer releases; refunds go to the payer; closes empty", () => {
    const e = platform.escrow;
    expect(e.funded?.status).toBe("Funded");
    expect(e.strangerCannotRelease && e.payeeCannotRelease && e.secondSessionReused).toBe(true);
    expect([e.studioDelta, e.clientDelta, e.heldAfter]).toEqual([300_000_000n, 500_000_000n, 0n]);
    expect(e.final?.milestones.map((m) => m.status)).toEqual(["Released", "Refunded"]);
  });

  it("wrong amounts and unknown escrows are returned in full; a funded escrow cannot be cancelled", async () => {
    const payee = await funded("escrow-payee", "0");
    const payer = await funded("escrow-payer", "10");
    const e = expectOk(
      await payee.gasless<Escrow>(appCalls(ids.app).createEscrow({
        payee: payee.id, payer: payer.id, milestones: [{ title: "Work", amount: "2000000" }], refundAfterMs: Date.now() + 86_400_000, metadataHash: "b".repeat(64),
      })),
      "create",
    ).value!;
    const before = await w.usdcBalance(payer.id);
    for (const [amount, id] of [[parseUsd("1"), e.id], [parseUsd("2"), 999]] as const) {
      const r = await payer.gaslessFull(ftCalls(ids.usdc).fundEscrow(ids.app, amount, id));
      expect(r.value).toBe("0");
    }
    expect(await w.usdcBalance(payer.id)).toBe(before);
    expect((await payer.gaslessFull(ftCalls(ids.usdc).fundEscrow(ids.app, parseUsd("2"), e.id))).value).toBe("2000000");
    expect((await payee.gasless(appCalls(ids.app).cancelEscrow(e.id))).ok).toBe(false);
    expect((await payer.gasless(appCalls(ids.app).refundMilestone(e.id, 0))).ok).toBe(false); // the payer cannot claw back before the date
    expect((await payer.gasless(appCalls(ids.app).releaseMilestone(e.id, 0))).ok).toBe(true);
    expect((await payer.gasless(appCalls(ids.app).releaseMilestone(e.id, 0))).ok).toBe(false); // not twice
    expect(await w.usdcBalance(payee.id)).toBe(parseUsd("2"));
  });
});

describe("agent allowances: spending limits enforced by the contract", () => {
  it("x402 from an allowance: paid gaslessly, limits enforced, revoke returns the rest", () => {
    const a = platform.agent;
    expect(a.status).toBe(200);
    expect(a.settlement?.success && a.receiptRecorded).toBe(true);
    expect(a.overLimitRefused && a.strangerRefused).toBe(true);
    expect([a.ownerRefund, a.agentNearSpent]).toEqual([4_800_000n, 0n]);
    expect(a.mcp).toMatchObject({ cappedRefused: true, status: 200, paid: "0.10" });
    expect(a.mandate).toMatchObject({ owner: "tidelab.cascade.sandbox", purpose: "Weather data for the store's delivery planning" });
    expect(a.allowance).toMatchObject({ revoked: true, balance: "0", total_spent: "200000", payments: 2 });
  });

  it("the daily limit holds across payments, and only the owner can top up its own allowance", async () => {
    const owner = await funded("budget-owner", "3");
    const agent = await w.plainAccount("budget-agent", 10n ** 23n);
    expectOk(await owner.gasless(appCalls(ids.app).setAllowance(agent.id, { per_payment_max: "1000000", daily_max: "1500000", expires_at_ms: Date.now() + 86_400_000, payees: [] })), "set");
    expectOk(await owner.gaslessFull(ftCalls(ids.usdc).fundAllowance(ids.app, parseUsd("3"), agent.id)), "fund");
    expect((await agent.gasless(appCalls(ids.app).agentPay(owner.id, ids.relayer, 1_000_000n, "a"))).ok).toBe(true);
    expect((await agent.gasless(appCalls(ids.app).agentPay(owner.id, ids.relayer, 1_000_000n, "b"))).ok).toBe(false); // 2.00 > 1.50 today
    expect((await agent.gasless(appCalls(ids.app).agentPay(owner.id, ids.relayer, 500_000n, "c"))).ok).toBe(true);
    const al = (await w.engine.reader.allowance(owner.id, agent.id))!;
    expect([al.balance, al.spent_today, al.payments]).toEqual(["1500000", "1500000", 2]);
    // Someone else's ft_transfer_call to this agent tops up *their own* (nonexistent) allowance: refused, money returned.
    const stranger = await funded("budget-stranger", "1");
    expect((await stranger.gaslessFull(ftCalls(ids.usdc).fundAllowance(ids.app, parseUsd("1"), agent.id))).value).toBe("0");
    expect(await w.usdcBalance(stranger.id)).toBe(parseUsd("1"));
  });
});
