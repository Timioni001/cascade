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
import { bucketSum, parseUsd, type CreatedBatch } from "@cascade/core";
import { RelayError } from "@cascade/relayer";
import { appCalls, daoCalls, DaoReader, ftCalls } from "@cascade/near";
import { payrollPolicy, registerOwnerProposal, functionCallProposal } from "@cascade/sputnik";
import { createWorld, ids, type Person, type World } from "../../scripts/sandbox/world.js";
import { personalFlow, teamFlow, type PersonalResult, type TeamResult } from "../../scripts/sandbox/flows.js";

let w: World;
let personal: PersonalResult;
let team: TeamResult;

beforeAll(async () => {
  w = await createWorld();
  personal = await personalFlow(w);
  team = await teamFlow(w, personal.ada);
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
