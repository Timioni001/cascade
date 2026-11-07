/**
 * The rest of the merchant platform, on the same local chain, after the
 * checkout story (checkout-flow.ts):
 *   21. settlement preference: the shop takes its money as USDC on Base
 *   22. a numbered wholesale invoice, paid in SOL from the hosted page
 *   23. a subscription with three months prepaid
 *   24. milestone escrow: a client funds it from Base, releases one milestone,
 *       the studio refunds the other; the contract holds the money in between
 *   25. an AI agent pays over x402 from an on-chain allowance with spending
 *       limits, gaslessly; the contract refuses what the limits forbid
 */
import { escrowHeld, formatUsd, hashDocument, parseUsd, type Allowance, type Escrow } from "@cascade/core";
import { ONBOARDING_RECIPIENT, expectOk, payoutMessage } from "@cascade/engine";
import { appCalls, ftCalls } from "@cascade/near";
import {
  Cascade, X402_HEADERS, decodeHeader, fetchWithPayment, x402Guard,
  type CheckoutSession, type Invoice, type Subscription, type X402Settlement,
} from "@cascade/sdk";
import { AgentWallet, McpServer } from "@cascade/mcp";
import type { CheckoutResult } from "./checkout-flow.js";
import type { Narrator } from "./flows.js";
import { ids, type Person, type World } from "./world.js";

const ETH_BASE = "nep141:base.omft.near";
const SOL = "nep141:sol.omft.near";
const BASE_ADDRESS = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";

export interface PlatformResult {
  payout: { refusedWithoutSignature: boolean; destinationAsset: string; recipient: string; nearUsdcDelta: bigint; paid: boolean; receiptRecorded: boolean; back: boolean };
  invoice: { number: string; amount: string; status: string; receiptId: number | null; events: string[] };
  subscription: { status: string; periodEnd: string | null; periodStart: string | null; prepaidInvoiceAmount: string };
  escrow: {
    funded: Escrow | null;
    final: Escrow | null;
    strangerCannotRelease: boolean;
    payeeCannotRelease: boolean;
    studioDelta: bigint;
    clientDelta: bigint;
    heldAfter: bigint;
    /** Asking again returns the same open session: an escrow never has two funding sessions. */
    secondSessionReused: boolean;
  };
  agent: {
    status: number;
    settlement: X402Settlement | null;
    receiptRecorded: boolean;
    overLimitRefused: boolean;
    strangerRefused: boolean;
    allowance: Allowance | null;
    ownerRefund: bigint;
    agentNearSpent: bigint;
    /** The receipt's mandate: who authorized the agent, and for what. */
    mandate: { owner: string; agent: string; purpose: string } | null;
    /** The same agent driven by an AI assistant through the Cascade MCP server. */
    mcp: { tools: string[]; leftToday: string | null; cappedRefused: boolean; status: number | null; paid: string | null };
  };
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** Pay a checkout session from another chain (mock 1Click) and let the settler record it. */
async function payFrom(w: World, sessionId: string, assetId: string, refundTo: string) {
  await post(`${w.apiUrl}/v1/public/sessions/${sessionId}/pay`, { assetId, refundTo });
  await post(`${w.apiUrl}/v1/public/dev/sessions/${sessionId}/simulate-deposit`);
  await w.settle();
}

async function signed(p: Person, message: string) {
  const issuedAt = message.match(/issued: (.+)$/m)![1]!;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const s = await p.full.signNep413Message({ message, recipient: ONBOARDING_RECIPIENT, nonce });
  return { signer: p.id, publicKey: s.publicKey.toString(), signature: Buffer.from(s.signature).toString("base64"), nonce: Buffer.from(nonce).toString("base64"), issuedAt };
}

export async function platformFlow(w: World, n: Narrator, k: CheckoutResult): Promise<PlatformResult> {
  const cascade = new Cascade({ apiKey: k.secretKey, baseUrl: w.apiUrl });
  const shop = k.shop;
  const auth = { authorization: `Bearer ${k.secretKey}` };
  return {
    payout: await payoutStory(w, n, cascade, shop, auth),
    invoice: await invoiceStory(w, n, cascade, auth),
    subscription: await subscriptionStory(w, n, cascade),
    escrow: await escrowStory(w, n, cascade, shop, auth),
    agent: await agentAllowanceStory(w, n, cascade, shop),
  };
}

// ------------------------------------------------------------ 21

async function payoutStory(w: World, n: Narrator, cascade: Cascade, shop: Person, auth: Record<string, string>): Promise<PlatformResult["payout"]> {
  n.step("21. The shop chooses where it gets paid: USDC on Base");
  const payout = { chain: "base", address: BASE_ADDRESS };
  const keyOnly = await fetch(`${w.apiUrl}/v1/merchant/payout`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ payout }) });
  const refusedWithoutSignature = keyOnly.status === 400;
  const issuedAt = new Date().toISOString();
  await cascade.merchant.setPayout(payout, await signed(shop, payoutMessage({ account: shop.id, payout, issuedAt })));
  n.ok(`Changing where money goes needs a NEP-413 signature from ${shop.id}, not just the API key (key alone: HTTP ${keyOnly.status})`);

  const before = await w.usdcBalance(shop.id);
  const s = await cascade.checkout.create({ amount: "25.00", description: "Stoneware mug, 350 ml", reference: "order-1003" });
  await payFrom(w, s.id, ETH_BASE, BASE_ADDRESS);
  const done = await cascade.checkout.retrieve(s.id);
  const rec = (await w.store.listPayments({ direction: "in" })).find((p) => p.sessionId === s.id)!;
  const nearUsdcDelta = (await w.usdcBalance(shop.id)) - before;
  n.ok(`Customer paid in ETH on Base; 1Click delivered $25.00 USDC on Base to ${BASE_ADDRESS.slice(0, 10)}… (simulated). Receipt #${done.receipt?.id} still recorded on NEAR.`);

  const back = await cascade.merchant.setPayout(null, await signed(shop, payoutMessage({ account: shop.id, payout: null, issuedAt: new Date().toISOString() })));
  n.say("Then it switches back to USDC on NEAR (signed again), for the stories that follow.");
  return {
    refusedWithoutSignature, destinationAsset: rec.quote.quoteRequest.destinationAsset, recipient: rec.quote.quoteRequest.recipient,
    nearUsdcDelta, paid: done.status === "paid", receiptRecorded: done.receipt !== null, back: (back as { payout: unknown }).payout === null,
  };
}

// ------------------------------------------------------------ 22

async function invoiceStory(w: World, n: Narrator, cascade: Cascade, auth: Record<string, string>): Promise<PlatformResult["invoice"]> {
  n.step("22. A wholesale invoice: 24 mugs for a café, paid in SOL");
  const inv = await cascade.invoices.create({
    customer: { name: "Fieldwork Café", email: "orders@fieldwork.example" },
    items: [{ description: "Stoneware mug, 350 ml", quantity: 24, unitAmount: "18.00" }, { description: "Shipping", unitAmount: "35.00" }],
    daysUntilDue: 14, memo: "Thank you for your order.",
  });
  n.ok(`${inv.number}: $${inv.amountFormatted} due ${inv.dueDate}. Hosted page: ${inv.url}`);
  const { sessionId } = (await (await post(`${w.apiUrl}/v1/public/invoices/${inv.id}/pay`)).json()) as { sessionId: string };
  await payFrom(w, sessionId, SOL, "11111111111111111111111111111111");
  const paid = await cascade.invoices.retrieve(inv.id);
  n.ok(`The café pressed Pay and paid in SOL: ${paid.number} is ${paid.status}, on-chain receipt #${paid.receipt?.id}`);
  const events = (await (await fetch(`${w.apiUrl}/v1/webhooks`, { headers: auth })).json()) as { data: { type: string }[] };
  return { number: paid.number, amount: paid.amount, status: paid.status, receiptId: paid.receipt?.id ?? null, events: events.data.map((e) => e.type) };
}

// ------------------------------------------------------------ 23

async function subscriptionStory(w: World, n: Narrator, cascade: Cascade): Promise<PlatformResult["subscription"]> {
  n.step("23. A subscription: mug of the month, three months prepaid");
  const plan = await cascade.plans.create({ name: "Mug of the month", amount: "12.00", interval: "month" });
  const sub = await cascade.subscriptions.create({ planId: plan.id, customer: { name: "Ines Duarte", email: "ines@example.com" }, prepaidPeriods: 3 });
  n.say(`Plan $${plan.amountFormatted}/${plan.interval}. First invoice ${sub.latestInvoice.number}: $${sub.latestInvoice.amountFormatted} for 3 months`);
  const { sessionId } = (await (await post(`${w.apiUrl}/v1/public/invoices/${sub.latestInvoice.id}/pay`)).json()) as { sessionId: string };
  await payFrom(w, sessionId, ETH_BASE, BASE_ADDRESS);
  const s: Subscription = await cascade.subscriptions.retrieve(sub.id);
  n.ok(`Subscription ${s.status}, paid until ${s.currentPeriodEnd?.slice(0, 10)}. Cascade issues the next invoice 3 days before; unpaid means past_due, then canceled.`);
  return { status: s.status, periodEnd: s.currentPeriodEnd, periodStart: s.currentPeriodStart, prepaidInvoiceAmount: sub.latestInvoice.amount };
}

// ------------------------------------------------------------ 24

async function escrowStory(w: World, n: Narrator, cascade: Cascade, shop: Person, auth: Record<string, string>): Promise<PlatformResult["escrow"]> {
  n.step("24. Milestone escrow: custom tableware for a restaurant, paid into the contract");
  const client = await w.signUp("marisco");
  const mallory = await w.plainAccount("mallory");
  const agreement = hashDocument({ kind: "escrow", scope: "Custom tableware: 40 plates and 40 bowls, two milestones" });
  const created = expectOk(
    await shop.gasless<Escrow>(
      appCalls(ids.app).createEscrow({
        payee: shop.id, payer: client.id, milestones: [{ title: "Glaze samples approved", amount: "300000000" }, { title: "Full set delivered", amount: "500000000" }],
        refundAfterMs: Date.now() + 30 * 86_400_000, metadataHash: agreement,
      }),
    ),
    "create escrow",
  ).value!;
  n.ok(`Escrow #${created.id}: $800.00 in two milestones, from ${client.id} to ${shop.id}. Refundable to the client after 30 days.`);

  // The client pays the escrow like any checkout, from Base; 1Click delivers into the contract.
  const session = await cascade.checkout.create({ amount: "800.00", description: `Escrow #${created.id}: custom tableware`, escrowId: created.id });
  const second = await fetch(`${w.apiUrl}/v1/checkout/sessions`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ amount: "800000000", description: "again", escrowId: created.id }),
  });
  const studioBefore = await w.usdcBalance(shop.id);
  const clientBefore = await w.usdcBalance(client.id);
  await payFrom(w, session.id, ETH_BASE, BASE_ADDRESS);
  const funded = await w.engine.reader.escrow(created.id);
  n.ok(`The client paid in ETH on Base; the contract now holds $${formatUsd(escrowHeld(funded!))} (status ${funded?.status}).`);

  const stranger = await mallory.gasless(appCalls(ids.app).releaseMilestone(created.id, 0));
  const payee = await shop.gasless(appCalls(ids.app).releaseMilestone(created.id, 0));
  n.say(`A stranger cannot release it (${stranger.ok ? "ALLOWED" : "refused"}); neither can the studio itself (${payee.ok ? "ALLOWED" : "refused"}).`);

  expectOk(await client.gasless(appCalls(ids.app).releaseMilestone(created.id, 0)), "release");
  n.ok("The client approves the glaze samples: milestone 1 ($300) goes to the studio. No fees for the client.");
  expectOk(await shop.gasless(appCalls(ids.app).refundMilestone(created.id, 1)), "refund");
  n.ok("The restaurant cancels the full set; the studio refunds milestone 2 ($500) to the client.");
  const final = await w.engine.reader.escrow(created.id);
  return {
    funded, final,
    strangerCannotRelease: !stranger.ok, payeeCannotRelease: !payee.ok,
    studioDelta: (await w.usdcBalance(shop.id)) - studioBefore,
    clientDelta: (await w.usdcBalance(client.id)) - clientBefore,
    heldAfter: final ? escrowHeld(final) : -1n,
    // Only one open session may fund an escrow (a second delivery would bounce).
    secondSessionReused: second.ok && ((await second.json()) as { id: string }).id === session.id,
  };
}

// ------------------------------------------------------------ 25

async function agentAllowanceStory(w: World, n: Narrator, cascade: Cascade, shop: Person): Promise<PlatformResult["agent"]> {
  n.step("25. An AI agent with a budget: on-chain spending limits, x402, no NEAR needed");
  const lab = await w.signUp("tidelab");
  await w.oneclick.driver.deliverUsdc(lab.id, parseUsd("5.00"));
  // The agent's account holds a little NEAR only because every NEAR account needs storage; it never spends any.
  const agent = await w.plainAccount("forecaster", 10n ** 23n);
  const policy = { per_payment_max: "500000", daily_max: "1000000", expires_at_ms: Date.now() + 7 * 86_400_000, payees: [shop.id] };
  expectOk(await lab.gasless(appCalls(ids.app).setAllowance(agent.id, policy, "Weather data for the store's delivery planning")), "set allowance");
  expectOk(await lab.gaslessFull(ftCalls(ids.usdc).fundAllowance(ids.app, parseUsd("5.00"), agent.id)), "fund allowance");
  n.ok(`${lab.id} gives ${agent.id} $5.00 to spend: at most $0.50 per payment, $1.00 a day, only at ${shop.id}, for 7 days.`);

  const agentNearBefore = await w.nearBalance(agent.id);
  const guard = x402Guard(cascade, { price: "0.10", description: "3-day forecast", assets: ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"] });
  const handler = async (req: Request) => {
    const g = await guard(req);
    return g.paid ? Response.json({ city: "Lisbon", days: 3 }, { headers: g.headers }) : g.response;
  };
  const res = await fetchWithPayment("https://oakline.example/api/forecast", {}, {
    // The settler runs continuously in production; here it runs after each answer.
    fetch: async (u, init) => {
      const r = await handler(new Request(String(u), init));
      if (r.status === 402) await w.settle();
      return r;
    },
    pollMs: 300,
    choose: (accepts) => {
      n.say(`402 offers: ${accepts.map((a) => `${a.extra.symbol} on ${a.extra.chain}${a.extra.method ? " (from an allowance)" : ""}`).join(", ")}`);
      return accepts.find((a) => a.extra.method === "agent_pay")!;
    },
    pay: async (req) => {
      const r = expectOk(await agent.gasless(appCalls(ids.app).agentPay(lab.id, req.payTo, BigInt(req.amount), req.extra.memo!)), "agent_pay");
      n.say(`The agent calls agent_pay(${lab.id}, ${req.payTo}, $${formatUsd(req.amount)}, "${req.extra.memo}") through the relayer`);
      return { txHash: r.hash, sender: w.relayer.account };
    },
  });
  const header = res.headers.get(X402_HEADERS.response);
  const settlement = header ? decodeHeader<X402Settlement>(header) : null;
  const sessions = (await cascade.checkout.list({ limit: 5 })).data as CheckoutSession[];
  const paidSession = sessions.find((s) => s.status === "paid" && s.description === "3-day forecast");
  n.ok(`HTTP ${res.status}: data delivered. Cascade verified the contract's agent_payment event; receipt #${paidSession?.receipt?.id} on-chain.`);
  const receipt = paidSession ? ((await (await fetch(`${w.apiUrl}/v1/public/sessions/${paidSession.id}/receipt`)).json()) as { mandate: PlatformResult["agent"]["mandate"] }) : null;
  n.say(`Its receipt shows the mandate: ${receipt?.mandate?.owner} authorized ${receipt?.mandate?.agent} for "${receipt?.mandate?.purpose}".`);

  n.step("26. The same agent, inside an AI assistant (Cascade MCP server)");
  const wallet = new AgentWallet({
    chain: w.chain, app: ids.app, owner: lab.id, agent: agent.id, agentKey: agent.key.toString(),
    relay: async (b64) => {
      const r = await w.relayer.relay(b64, { ip: "127.0.0.1" });
      return { hash: r.hash, ok: r.ok, error: r.error ?? null, signer: w.relayer.account };
    },
    fetch: async (u, init) => {
      const r = await handler(new Request(String(u), init));
      if (r.status === 402) await w.settle();
      return r;
    },
  });
  const mcp = new McpServer({ name: "cascade", title: "Cascade", version: "0.1.0" }, wallet.tools());
  type ToolResult = { result: { structuredContent?: Record<string, unknown>; isError?: boolean; content: { text: string }[] } };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as ToolResult).result;
  const tools = ((await mcp.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" })) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  const st = await call("wallet_status");
  n.say(`The assistant sees tools ${tools.join(", ")}; wallet_status: $${st.structuredContent?.balance} left, $${st.structuredContent?.leftToday} today, purpose "${st.structuredContent?.purpose}"`);
  const capped = await call("paid_fetch", { url: "https://oakline.example/api/forecast", max_usd: 0.05 });
  n.say(`Asked to spend at most $0.05 on a $0.10 call, it refuses: ${capped.content[0]?.text}`);
  const viaMcp = await call("paid_fetch", { url: "https://oakline.example/api/forecast" });
  const vm = viaMcp.structuredContent as { status: number; paid: { amount: string } | null } | undefined;
  n.ok(`paid_fetch: HTTP ${vm?.status}, paid $${vm?.paid?.amount} from the budget, no gas, no wallet popup.`);

  const over = await agent.gasless(appCalls(ids.app).agentPay(lab.id, shop.id, 600_000n, "too much"));
  const elsewhere = await agent.gasless(appCalls(ids.app).agentPay(lab.id, ids.relayer, 100_000n, "elsewhere"));
  n.say(`$0.60 in one payment: ${over.ok ? "ALLOWED" : "refused by the contract"}. Paying anyone but the shop: ${elsewhere.ok ? "ALLOWED" : "refused"}.`);
  const labBefore = await w.usdcBalance(lab.id);
  expectOk(await lab.gasless(appCalls(ids.app).revokeAllowance(agent.id)), "revoke");
  const ownerRefund = (await w.usdcBalance(lab.id)) - labBefore;
  n.ok(`${lab.id} revokes the agent; the unspent $${formatUsd(ownerRefund)} comes straight back.`);
  return {
    status: res.status, settlement, receiptRecorded: !!paidSession?.receipt,
    overLimitRefused: !over.ok, strangerRefused: !elsewhere.ok,
    allowance: await w.engine.reader.allowance(lab.id, agent.id),
    ownerRefund, agentNearSpent: agentNearBefore - (await w.nearBalance(agent.id)),
    mandate: receipt?.mandate ?? null,
    mcp: {
      tools, leftToday: (st.structuredContent?.leftToday as string | undefined) ?? null, cappedRefused: capped.isError === true,
      status: vm?.status ?? null, paid: vm?.paid?.amount ?? null,
    },
  };
}
