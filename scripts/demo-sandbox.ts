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
  const k = await checkoutFlow(world, narrator);

  console.log(`\n${bold("18. The accountant's CSV (Ada, then the studio)")}`);
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
