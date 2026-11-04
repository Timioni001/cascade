/**
 * pnpm demo
 *
 * Runs both Cascade stories on a local NEAR sandbox, with no keys and no
 * money: the real app, factory and Sputnik DAO contracts, a mock USDC, the
 * relayer and settler in-process, and MockOneClick standing in for NEAR
 * Intents (which has no testnet). Prints every step and exits non-zero if
 * any check fails.
 */
import { bucketSum, formatUsd } from "@cascade/core";
import { createWorld } from "./sandbox/world.js";
import { personalFlow, teamFlow, type Narrator } from "./sandbox/flows.js";
import { checkoutFlow } from "./sandbox/checkout-flow.js";
import { platformFlow } from "./sandbox/platform-flow.js";

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1");
const dim = c("2");
const green = c("32");
const red = c("31");

const narrator: Narrator = {
  step: (t) => console.log(`\n${bold(t)}`),
  say: (t) => console.log(`  ${dim(t)}`),
  ok: (t) => console.log(`  ${green("✓")} ${t}`),
  table: (rows) => {
    if (!rows.length) return;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const w = cols.map((k) => Math.max(k.length, ...rows.map((r) => (r[k] ?? "").length)));
    const line = (vals: string[]) => "  " + vals.map((v, i) => v.padEnd(w[i]!)).join("  ");
    console.log(dim(line(cols)));
    for (const r of rows) console.log(line(cols.map((k) => r[k] ?? "")));
  },
};

const failures: string[] = [];
function check(cond: boolean, what: string) {
  if (cond) console.log(`  ${green("✓")} ${what}`);
  else {
    console.log(`  ${red("✗")} ${what}`);
    failures.push(what);
  }
}

console.log(bold("Cascade demo: get paid from any chain, pay anyone, no fees. Local NEAR sandbox, no keys, no money."));
console.log(dim("Starting a NEAR sandbox node (nearcore 2.14.0, same as mainnet) and deploying contracts..."));
const started = Date.now();
const world = await createWorld();
let exit = 0;
try {
  const p = await personalFlow(world, narrator);
  const t = await teamFlow(world, p.ada, narrator);
  const k = await checkoutFlow(world, narrator, { dao: t.dao });
  const x = await platformFlow(world, narrator, k);

  console.log(`\n${bold("26. The accountant's CSV (Ada, then the studio)")}`);
  for (const csv of [p.csv, t.csv]) {
    for (const row of csv.trim().split("\r\n")) console.log(`  ${dim(row.length > 160 ? row.slice(0, 157) + "..." : row)}`);
    console.log("");
  }

  console.log(bold("Checks"));
  check(p.invoice.status === "Paid" && p.invoice.settlement !== null, "invoice paid from Base is Paid on-chain, with deposit address and NEAR tx recorded");
  check(p.linkInvoice.source === "Link" && p.linkInvoice.status === "Paid", "payment-link receipt recorded on-chain");
  check(p.adaUsdcAfterIn === 345_000_000n, `Ada received exactly $345.00 (got $${formatUsd(p.adaUsdcAfterIn)})`);
  check(p.batch.status === "Done" && p.lines.every((l) => l.status === "Sent"), "personal batch Done, every line Sent once");
  check(p.adaNearStart - p.adaNearEnd <= 1n, "Ada paid no network fees (at most the 1 yoctoNEAR token deposit)");
  check(p.lines.every((l) => p.recipients[l.recipient] === BigInt(l.amount)), "each recipient (or 1Click deposit address) holds exactly its line amount");
  check(t.registerProposal.status === "Approved", "the DAO registered with Cascade through its own proposal");
  check(t.proposalProblems.length === 0, "funding proposal verified: exact total and hash, into Cascade, nothing else");
  check(t.preparerFundAttempt.adaUsdcAfter === t.preparerFundAttempt.adaUsdcBefore && t.preparerFundAttempt.batchStatus === "Draft", "a preparer cannot fund the team's batch; her tokens came back");
  check(t.fundedAfterOneVote.status === "Draft", "one approval is not enough; the batch stayed unfunded");
  check(t.batch.status === "PartlyRefunded", "team batch finished with the frozen line refunded");
  check(bucketSum(t.batch.buckets) === BigInt(t.batch.total) && BigInt(t.batch.buckets.sent) + BigInt(t.batch.buckets.refunded) === BigInt(t.batch.total), "Sent + Refunded == batch total");
  check(t.daoUsdcEnd === t.daoUsdcAfterIncome - BigInt(t.batch.buckets.sent), "the DAO paid only what was delivered; the refund is back in its treasury");
  check(t.approverNearBefore.every((b, i) => b === t.approverNearAfter[i]), "approvers voted without paying fees");
  check(k.session.status === "paid" && k.replayedSessionId === k.session.id, "checkout session paid; a retried create returned the same session");
  check(k.merchantUsdcDelta === 25_000_000n && !k.cascadeHeldAnything, "the shop received exactly $25.00 directly; Cascade held nothing");
  check(k.receipt?.source === "Link" && k.receiptHashMatches, "on-chain receipt is bound to the session by hash");
  check(k.webhook?.type === "checkout.session.completed" && k.webhook.data.session.reference === "order-1001", "merchant verified a signed checkout.session.completed webhook");
  check(k.webhookRejectedForgery, "a forged webhook was rejected by the merchant's SDK check");
  check(k.split.paid && k.split.rule.shares.every((x, i) => k.split.received[x.account] === k.split.expected[i]), "the split paid 80/15/5 exactly, on arrival, with no signatures");
  check(k.split.expected.reduce((a, b) => a + b, 0n) === 25_000_000n, "split parts add up to the payment");
  check(k.refund.status === "succeeded" && k.refund.amount === "10000000" && k.refund.webhookType === "refund.succeeded", "a $10 refund reached the customer in ETH on Base, and the shop got refund.succeeded");
  check(k.agent.status === 200 && k.agent.settlement?.success === true, "an AI agent paid over x402 and got its data");
  check(k.agent.replayStatus === 402 && k.agent.replayReason === "already_used", "replaying the agent's payment does not unlock a second response");
  const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
  check(x.payout.refusedWithoutSignature, "the API key alone cannot change where money goes; a NEP-413 signature from the account can");
  check(x.payout.destinationAsset === USDC_BASE && x.payout.recipient === "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" && x.payout.nearUsdcDelta === 0n, "with a Base payout, 1Click was asked to deliver USDC on Base to the shop's address (nothing on NEAR)");
  check(x.payout.paid && x.payout.receiptRecorded && x.payout.back, "that sale still has an on-chain receipt on NEAR; the shop switched back");
  check(x.invoice.status === "paid" && x.invoice.amount === "467000000" && x.invoice.receiptId !== null, `invoice ${x.invoice.number} ($467.00, 2 line items) paid in SOL, with an on-chain receipt`);
  check(x.invoice.events.includes("invoice.created") && x.invoice.events.includes("invoice.paid"), "the shop got invoice.created and invoice.paid webhooks");
  check(x.subscription.status === "active" && x.subscription.prepaidInvoiceAmount === "36000000" && !!x.subscription.periodEnd && Date.parse(x.subscription.periodEnd) - Date.parse(x.subscription.periodStart!) > 85 * 86_400_000, "a subscription with 3 months prepaid ($36.00) is active for 3 months");
  check(x.escrow.funded?.status === "Funded" && x.escrow.funded.total === "800000000" && x.escrow.secondSessionRefused, "the escrow was funded from Base through checkout ($800.00, held by the contract); a second funding session was refused");
  check(x.escrow.strangerCannotRelease && x.escrow.payeeCannotRelease, "neither a stranger nor the studio itself can release escrowed money");
  check(x.escrow.studioDelta === 300_000_000n && x.escrow.clientDelta === 500_000_000n && x.escrow.heldAfter === 0n && x.escrow.final?.status === "Closed", "client released $300 to the studio, the studio refunded $500 to the client; escrow closed holding nothing");
  check(x.agent.status === 200 && x.agent.settlement?.success === true && x.agent.receiptRecorded, "an AI agent paid over x402 from its on-chain allowance, gaslessly; the payment has a receipt");
  check(x.agent.overLimitRefused && x.agent.strangerRefused, "the contract refused a payment above the agent's limit, and one to a recipient not on its list");
  check(x.agent.allowance?.revoked === true && x.agent.ownerRefund === 4_900_000n && x.agent.agentNearSpent === 0n, "revoking returned the unspent $4.90 to the owner; the agent spent no NEAR at all");
} catch (e) {
  exit = 1;
  console.error(red(`\nDemo failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
} finally {
  await world.stop();
}

if (failures.length) exit = 1;
console.log(
  exit === 0
    ? green(bold(`\nAll checks passed in ${((Date.now() - started) / 1000).toFixed(0)}s.`))
    : red(bold(`\n${failures.length} check(s) failed.`)),
);
process.exit(exit);
