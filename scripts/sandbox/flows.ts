/**
 * The two Cascade stories, end to end on a sandbox `World`:
 *   personalFlow - Ada, a designer in Lagos, gets paid from Base and splits it.
 *   teamFlow     - Ada's studio (a Sputnik DAO) runs payroll after 2 of 3 approve.
 * `pnpm demo` narrates them; contracts/tests asserts on what they return.
 */
import { bucketSum, formatUsd, parseUsd, type Batch, type Invoice, type Line } from "@cascade/core";
import { ledgerRows, toCsv } from "@cascade/db";
import { expectOk } from "@cascade/engine";
import { daoCalls, DaoReader, ftCalls } from "@cascade/near";
import { plainStatus } from "@cascade/oneclick";
import { approvals, payrollPolicy, verifyFundingProposal, type Proposal } from "@cascade/sputnik";
import { ids, type Person, type World } from "./world.js";

export interface Narrator {
  step(title: string): void;
  say(text: string): void;
  ok(text: string): void;
  table(rows: Record<string, string>[]): void;
}

export const silent: Narrator = { step() {}, say() {}, ok() {}, table() {} };

const ETH_BASE = "nep141:base.omft.near";
const SOL = "nep141:sol.omft.near";
const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";

const usd = (v: bigint | string) => `$${formatUsd(v)}`;

function lineRows(lines: Line[]) {
  return lines.map((l, i) => ({
    "#": String(i + 1),
    to: l.dest ?? l.recipient,
    kind: l.kind,
    amount: usd(l.amount),
    status: l.status,
    ...(l.note ? { note: l.note } : {}),
  }));
}

/** Pay `amount` to `owner` from another chain, as a payer would through the invoice page. */
async function payFromAnotherChain(w: World, n: Narrator, p: { owner: string; amount: bigint; payAsset: string; payChain: string; payer: string; refundTo: string; invoiceId?: number }) {
  const common = { owner: p.owner, amount: p.amount, payAsset: p.payAsset, payChain: p.payChain, refundTo: p.refundTo, payer: p.payer, ...(p.invoiceId !== undefined ? { invoiceId: p.invoiceId } : {}) };
  const preview = await w.engine.quoteForPayer({ ...common, dry: true });
  n.say(`Preview (dry quote): pay ${preview.quote.amountInFormatted} on ${p.payChain} ≈ $${Number(preview.quote.amountInUsd).toFixed(2)}, ${p.owner} receives ${usd(preview.quote.amountOut)} USDC`);
  const real = await w.engine.quoteForPayer({ ...common, dry: false });
  const dep = real.quote.depositAddress!;
  n.say(`Payer confirms. One-time deposit address on ${p.payChain}: ${dep}`);
  await w.oneclick.simulatePayerDeposit(dep);
  n.say("Payer sends; NEAR Intents swaps and delivers USDC on NEAR (mock 1Click + solver)");
  return dep;
}

export interface PersonalResult {
  ada: Person;
  invoice: Invoice;
  linkInvoice: Invoice;
  batch: Batch;
  lines: Line[];
  adaUsdcAfterIn: bigint;
  adaUsdcEnd: bigint;
  adaNearStart: bigint;
  adaNearEnd: bigint;
  recipients: Record<string, bigint>;
  csv: string;
}

export async function personalFlow(w: World, n: Narrator = silent): Promise<PersonalResult> {
  n.step("1. Ada signs up and gets a name");
  const ada = await w.signUp("ada");
  const adaNearStart = await w.nearBalance(ada.id);
  n.ok(`${ada.id} created by the factory. No seed phrase shown; the key stays in her browser.`);
  n.say(`A second key can only call ${ids.app}; it signs her everyday actions. Her NEAR balance: ${Number(adaNearStart) / 1e24} (paid by Cascade)`);
  await w.engine.registerPerson(ada.gasless);
  n.ok("Registered with Cascade (fee paid by the relayer, NEP-366)");

  n.step("2. Ada invoices her client in Berlin for $300");
  const { invoice: created, doc } = await w.engine.createInvoice(ada.gasless, {
    owner: ada.id, amount: parseUsd("300"), title: "Brand identity, October", client: { name: "Berlin Studio GmbH" },
    items: [{ description: "Logo and brand guide", quantity: 1, unitPrice: parseUsd("300").toString() }], dueDate: "2026-11-30",
  });
  n.ok(`Invoice #${created.id} is on-chain as Open. Only a hash of the details is public: ${doc.metadataHash.slice(0, 16)}...`);

  n.step("3. The client pays in ETH on Base");
  const dep = await payFromAnotherChain(w, n, { owner: ada.id, amount: parseUsd("300"), payAsset: ETH_BASE, payChain: "base", payer: "Berlin Studio GmbH", refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", invoiceId: created.id });
  await w.settle();
  const invoice = (await w.engine.reader.invoice(created.id))!;
  n.ok(`Settler saw SUCCESS and marked invoice #${invoice.id} ${invoice.status}. Ada's balance: ${usd(await w.usdcBalance(ada.id))} USDC`);
  n.say(`Recorded on-chain: deposit ${dep.slice(0, 12)}..., delivered ${usd(invoice.settlement!.amount_out)}, NEAR tx ${invoice.settlement!.dest_tx.slice(0, 12)}...`);

  n.step("4. Someone else pays her public link (cascade.link/ada) with SOL");
  const linkDep = await payFromAnotherChain(w, n, { owner: ada.id, amount: parseUsd("45"), payAsset: SOL, payChain: "sol", payer: "a reader of her blog", refundTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" });
  await w.settle();
  const linkInvoice = (await w.engine.reader.invoice(created.id + 1))!;
  const adaUsdcAfterIn = await w.usdcBalance(ada.id);
  n.ok(`Link payment recorded as receipt #${linkInvoice.id} (${linkInvoice.source}), deposit ${linkDep.slice(0, 12)}... Balance: ${usd(adaUsdcAfterIn)}`);

  n.step("5. Ada splits: rent on Solana, her sister privately on Base, a friend on NEAR");
  const tunde = await w.plainAccount("tunde");
  const created2 = await w.engine.createBatch(ada.gasless, {
    owner: ada.id, title: "November split",
    payees: [
      { name: "Landlord", chain: "sol", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: parseUsd("120") },
      { name: "Sister", chain: "base", address: "0x7a16fF8270133F063aAb6C9977183D9e72835428", amount: parseUsd("50"), private: true },
      { name: "Tunde", chain: "near", address: tunde.id, amount: parseUsd("30") },
    ],
  });
  n.ok(`Batch #${created2.id} locked: total ${usd(created2.total)}, hash ${created2.hash.slice(0, 16)}...`);
  n.table(lineRows(await w.engine.reader.lines(created2.id)));
  n.say("Cross-chain lines pay a 1Click deposit address fixed now; the contract refuses to pay it after the quote deadline.");

  n.step("6. Ada approves and funds it with one signature (still no fee)");
  expectOk(await ada.gaslessFull(w.engine.fundCall(created2)), "fund batch");
  n.ok(`Batch #${created2.id}: ${(await w.engine.reader.batch(created2.id))!.status}`);
  await w.settle();
  const batch = (await w.engine.reader.batch(created2.id))!;
  const lines = await w.engine.reader.lines(created2.id);
  n.ok(`Batch #${batch.id}: ${batch.status}`);
  n.table(lineRows(lines));
  for (const d of (await w.store.getBatch(batch.id))!.lines) {
    if (!d.depositAddress) continue;
    const p = (await w.store.getPayment(d.depositAddress))!;
    n.say(`${d.name} on ${d.chain}${d.private ? " (private)" : ""}: ${plainStatus(p.status)}, destination tx ${p.destTx?.slice(0, 14)}...`);
  }
  const adaNearEnd = await w.nearBalance(ada.id);
  const adaUsdcEnd = await w.usdcBalance(ada.id);
  n.ok(`Ada now holds ${usd(adaUsdcEnd)} USDC. NEAR spent on fees: ${Number(adaNearStart - adaNearEnd) / 1e24} (1 yoctoNEAR is the token standard's deposit)`);

  const recipients: Record<string, bigint> = { [tunde.id]: await w.usdcBalance(tunde.id) };
  for (const l of lines) recipients[l.recipient] = await w.usdcBalance(l.recipient);
  const csv = toCsv(await ledgerRows(w.store, ada.id, { chain: { batch: (id) => w.engine.reader.batch(id), lines: (id) => w.engine.reader.lines(id) } }));
  return { ada, invoice, linkInvoice, batch, lines, adaUsdcAfterIn, adaUsdcEnd, adaNearStart, adaNearEnd, recipients, csv };
}

export interface TeamResult {
  dao: string;
  approvers: Person[];
  approverNearBefore: bigint[];
  approverNearAfter: bigint[];
  registerProposal: Proposal;
  fundProposal: Proposal;
  proposalProblems: string[];
  fundedAfterOneVote: Batch;
  preparerFundAttempt: { adaUsdcBefore: bigint; adaUsdcAfter: bigint; batchStatus: string };
  batch: Batch;
  lines: Line[];
  daoUsdcAfterIncome: bigint;
  daoUsdcEnd: bigint;
  csv: string;
}

export async function teamFlow(w: World, ada: Person, n: Narrator = silent): Promise<TeamResult> {
  n.step("7. Ada's studio is a Sputnik DAO: finance = Ada, approvers = Bola, Chidi, Dami (2 of 3)");
  const approvers = [await w.plainAccount("bola"), await w.plainAccount("chidi"), await w.plainAccount("dami")];
  const approverNearBefore = await Promise.all(approvers.map((a) => w.nearBalance(a.id)));
  const dao = await w.createDao("studio", payrollPolicy({ finance: [ada.id], approvers: approvers.map((a) => a.id), threshold: 2 }));
  const daoRead = new DaoReader(w.chain, dao);
  n.ok(`${dao} uses the real Sputnik DAO v2 contract from mainnet. Cascade never takes custody.`);

  const vote = async (who: Person, id: number) => {
    const p = await daoRead.proposal(id);
    expectOk(await who.gasless(daoCalls(dao).act(id, "VoteApprove", p.kind)), `vote by ${who.id}`);
  };

  n.step("8. The studio joins Cascade through its own proposal");
  // Ada's limited key only works on the Cascade contract, so DAO calls are
  // signed with her own full key. They are still relayed: she pays nothing.
  const reg = expectOk(await ada.gaslessFull<number>(w.engine.proposeRegisterDao(dao, [ada.id])), "propose registration");
  const regId = reg.value!;
  n.say(`Ada proposed #${regId}: "register with Cascade, Ada may prepare payments". Bola and Chidi approve without paying fees.`);
  await vote(approvers[0]!, regId);
  await vote(approvers[1]!, regId);
  const registerProposal = await daoRead.proposal(regId);
  const owner = await w.engine.reader.owner(dao);
  n.ok(`Proposal #${regId}: ${registerProposal.status}. Cascade owner ${owner?.id} is a ${owner?.kind}; preparers: ${owner?.preparers.join(", ")}`);

  n.step("9. A client pays the studio's $1,500 invoice in USDC on Arbitrum");
  const { invoice } = await w.engine.createInvoice(ada.gasless, { owner: dao, amount: parseUsd("1500"), title: "Website build", client: { name: "Lisbon Coffee Co." } });
  await payFromAnotherChain(w, n, { owner: dao, amount: parseUsd("1500"), payAsset: USDC_ARB, payChain: "arb", payer: "Lisbon Coffee Co.", refundTo: "0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97", invoiceId: invoice.id });
  await w.settle();
  const daoUsdcAfterIncome = await w.usdcBalance(dao);
  n.ok(`Invoice #${invoice.id} ${(await w.engine.reader.invoice(invoice.id))!.status}. The DAO treasury holds ${usd(daoUsdcAfterIncome)} USDC.`);

  n.step("10. Ada prepares payroll for three people on three chains (and an old vendor)");
  const kemi = await w.plainAccount("kemi");
  const oldVendor = await w.plainAccount("old-vendor");
  // Real USDC can freeze accounts. Freezing this one forces a failed line, to show refunds.
  await w.freeze(oldVendor.id);
  const created = await w.engine.createBatch(ada.gasless, {
    owner: dao, title: "Studio payroll, November",
    payees: [
      { name: "Kemi (NEAR)", chain: "near", address: kemi.id, amount: parseUsd("400") },
      { name: "Designer (Solana)", chain: "sol", address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", amount: parseUsd("350") },
      { name: "Developer (Arbitrum)", chain: "arb", address: "0x1Db3439a222C519ab44bb1144fC28167b4Fa6EE6", amount: parseUsd("500") },
      { name: "Old vendor (frozen)", chain: "near", address: oldVendor.id, amount: parseUsd("100") },
    ],
  });
  n.ok(`Batch #${created.id} for ${dao}: ${usd(created.total)}. Ada can prepare it but cannot fund it.`);

  n.step("11. Ada proposes funding; approvers check it and vote");
  const prop = expectOk(await ada.gaslessFull<number>(w.engine.proposeFundingCall(dao, (await w.engine.reader.batch(created.id))!)), "propose funding");
  const fundId = prop.value!;
  await w.engine.linkProposal(ada.gasless, created.id, fundId);
  let fundProposal = await daoRead.proposal(fundId);
  const proposalProblems = verifyFundingProposal(fundProposal, (await w.engine.reader.batch(created.id))!, { usdc: ids.usdc, cascade: ids.app });
  n.say(`Proposal #${fundId}: "${fundProposal.description.slice(0, 90)}..."`);
  n.ok(proposalProblems.length === 0 ? "Verifier: it sends exactly the batch total, with the batch hash, to Cascade. Nothing else." : `Verifier problems: ${proposalProblems.join("; ")}`);

  // Ada tries to fund the team batch herself: the contract sends it all back.
  const adaUsdcBefore = await w.usdcBalance(ada.id);
  const b0 = (await w.engine.reader.batch(created.id))!;
  await ada.gaslessFull(ftCalls(ids.usdc).fundBatch(ids.app, BigInt(b0.total) > adaUsdcBefore ? adaUsdcBefore : BigInt(b0.total), { batch_id: b0.id, hash: b0.hash }));
  const preparerFundAttempt = { adaUsdcBefore, adaUsdcAfter: await w.usdcBalance(ada.id), batchStatus: (await w.engine.reader.batch(created.id))!.status };
  n.say(`Ada tries to fund the team batch from her own account: refused, her ${usd(adaUsdcBefore)} comes back (${usd(preparerFundAttempt.adaUsdcAfter)}). Batch still ${preparerFundAttempt.batchStatus}.`);

  await vote(approvers[0]!, fundId);
  const fundedAfterOneVote = (await w.engine.reader.batch(created.id))!;
  n.say(`Bola approves (1 of 2). Batch: ${fundedAfterOneVote.status}`);
  await vote(approvers[2]!, fundId);
  fundProposal = await daoRead.proposal(fundId);
  n.ok(`Dami approves (2 of 2). Proposal ${fundProposal.status}; the DAO itself sent the USDC. Batch: ${(await w.engine.reader.batch(created.id))!.status}`);
  const doc = (await w.store.getBatch(created.id))!;
  await w.store.putBatch({ ...doc, approvers: approvals(fundProposal) });

  n.step("12. The settler pays every line in chunks and refunds what failed");
  await w.settle();
  const batch = (await w.engine.reader.batch(created.id))!;
  const lines = await w.engine.reader.lines(created.id);
  n.table(lineRows(lines));
  const daoUsdcEnd = await w.usdcBalance(dao);
  n.ok(`Batch #${batch.id}: ${batch.status}. Sent ${usd(batch.buckets.sent)} + refunded ${usd(batch.buckets.refunded)} = ${usd(bucketSum(batch.buckets))} of ${usd(batch.total)}`);
  n.ok(`The frozen vendor's $100 went back to the DAO: treasury ${usd(daoUsdcEnd)}`);
  const approverNearAfter = await Promise.all(approvers.map((a) => w.nearBalance(a.id)));
  n.ok(`Approvers' NEAR spent on fees: ${approverNearBefore.map((b, i) => Number(b - approverNearAfter[i]!) / 1e24).join(", ")}`);

  const csv = toCsv(await ledgerRows(w.store, dao, { chain: { batch: (id) => w.engine.reader.batch(id), lines: (id) => w.engine.reader.lines(id) } }));
  return {
    dao, approvers, approverNearBefore, approverNearAfter, registerProposal, fundProposal, proposalProblems, fundedAfterOneVote,
    preparerFundAttempt, batch, lines, daoUsdcAfterIncome, daoUsdcEnd, csv,
  };
}
