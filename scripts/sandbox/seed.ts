/**
 * Realistic history for the demo merchant in `pnpm dev`, so every dashboard
 * screen has something real on it: a contractor payout across three chains,
 * two milestone escrows (one funded and half released, one waiting for the
 * client), and an AI agent's budget with a first purchase. All on the local
 * chain, through the same contracts and calls as production.
 */
import { parseUsd } from "@cascade/core";
import { payrollPolicy } from "@cascade/sputnik";
import type { Store } from "@cascade/db";
import { expectOk } from "@cascade/engine";
import { appCalls, ftCalls } from "@cascade/near";
import { ids, type Person, type World } from "./world.js";

const DAY = 86_400_000;

export async function seedMerchant(w: World, shop: Person, platformStore: Store, log: (s: string) => void = () => {}) {
  await w.oneclick.driver.deliverUsdc(shop.id, parseUsd("2000"));

  // A payout to contractors on three chains, locked, funded and paid.
  const assistant = await w.plainAccount("studio-assistant");
  const batch = await w.engine.createBatch(shop.gasless, {
    owner: shop.id, title: "Contractors, November",
    payees: [
      { name: "Glaze supplier", chain: "base", address: "0x7a16fF8270133F063aAb6C9977183D9e72835428", amount: parseUsd("240") },
      { name: "Product photographer", chain: "sol", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: parseUsd("180") },
      { name: "Studio assistant", chain: "near", address: assistant.id, amount: parseUsd("400") },
    ],
  });
  expectOk(await shop.gaslessFull(w.engine.fundCall(batch)), "fund payout");
  await w.settle();
  const doc = await w.store.getBatch(batch.id);
  if (doc) await platformStore.putBatch(doc);
  log(`payout #${batch.id} to 3 chains`);

  // Escrow 1: funded by the client and half released. Escrow 2: waiting for the client.
  const marisco = await w.signUp("marisco");
  const fieldwork = await w.signUp("fieldwork");
  const e1 = expectOk(await shop.gasless<{ id: number }>(appCalls(ids.app).createEscrow({
    payee: shop.id, payer: marisco.id, refundAfterMs: Date.now() + 45 * DAY, metadataHash: "1".repeat(64),
    milestones: [{ title: "Glaze samples approved", amount: "300000000" }, { title: "40 plates and 40 bowls delivered", amount: "500000000" }],
  })), "escrow 1").value!;
  await w.oneclick.driver.deliverUsdc(marisco.id, parseUsd("800"));
  expectOk(await marisco.gaslessFull(ftCalls(ids.usdc).fundEscrow(ids.app, parseUsd("800"), e1.id)), "fund escrow 1");
  expectOk(await marisco.gasless(appCalls(ids.app).releaseMilestone(e1.id, 0)), "release");
  expectOk(await shop.gasless(appCalls(ids.app).createEscrow({
    payee: shop.id, payer: fieldwork.id, refundAfterMs: Date.now() + 60 * DAY, metadataHash: "2".repeat(64),
    milestones: [{ title: "Custom mug design", amount: "400000000" }, { title: "Production run of 200", amount: "800000000" }],
  })), "escrow 2");
  log("2 escrows");

  // An agent that restocks supplies, with a budget and one purchase.
  const agent = await w.plainAccount("oakline-assistant", 10n ** 23n);
  const supplier = await w.plainAccount("glazeco");
  expectOk(await shop.gasless(appCalls(ids.app).setAllowance(agent.id, {
    per_payment_max: "25000000", daily_max: "100000000", expires_at_ms: Date.now() + 30 * DAY, payees: [supplier.id],
  }, "Restock glaze and packaging from approved suppliers")), "allowance");
  expectOk(await shop.gaslessFull(ftCalls(ids.usdc).fundAllowance(ids.app, parseUsd("250"), agent.id)), "fund allowance");
  expectOk(await agent.gasless(appCalls(ids.app).agentPay(shop.id, supplier.id, parseUsd("18.40"), "glazeco order 4471")), "agent purchase");
  log("1 agent budget");

  // A revenue split with a community treasury: every sale paid into it is
  // divided on arrival between the studio, its illustrator and a Sputnik DAO.
  const illustrator = await w.plainAccount("illustrator");
  const coop = await w.createDao("makers-coop", payrollPolicy({ finance: [shop.id], approvers: [shop.id], threshold: 1 }));
  const split = expectOk(await shop.gasless<{ id: number }>(appCalls(ids.app).createSplit(shop.id, [
    { account: shop.id, bps: 8000 }, { account: illustrator.id, bps: 1500 }, { account: coop, bps: 500 },
  ])), "create split").value!;
  await platformStore.putDoc("split", String(split.id), (await platformStore.findMerchantByAccount(shop.id))!.id, { id: split.id, addedAt: new Date().toISOString() });
  log(`split #${split.id}: 80% studio, 15% illustrator, 5% makers co-op DAO`);
}
