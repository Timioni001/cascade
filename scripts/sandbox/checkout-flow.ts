/**
 * The merchant story: a ceramics studio sells a mug to a customer who pays
 * in ETH on Base. Everything a real integration touches is real here:
 * an NEP-413 signature checked against the shop's on-chain key, the checkout
 * API over HTTP, the public SDK, a merchant webhook server that verifies
 * signatures, and the on-chain receipt. Only 1Click is mocked.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { formatUsd, splitAmount, type CreatedBatch, type Invoice, type LineInput, type SplitRule } from "@cascade/core";
import { Checkout, ONBOARDING_RECIPIENT, expectOk, onboardingMessage } from "@cascade/engine";
import { appCalls, ftCalls } from "@cascade/near";
import {
  Cascade, X402_HEADERS, buildEvmTransfer, decodeHeader, fetchWithPayment, verifyWebhook, x402Guard,
  type CheckoutSession, type PaymentPreview, type WebhookEvent, type X402Settlement,
} from "@cascade/sdk";
import type { Narrator } from "./flows.js";
import { ids, type Person, type World } from "./world.js";

const ETH_BASE = "nep141:base.omft.near";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

export interface CheckoutResult {
  merchant: string;
  /** The shop's account and API key, for the stories that follow (platform-flow.ts). */
  shop: Person;
  secretKey: string;
  session: CheckoutSession;
  replayedSessionId: string;
  webhook: WebhookEvent | null;
  webhookRejectedForgery: boolean;
  receipt: Invoice | null;
  receiptHashMatches: boolean;
  merchantUsdcDelta: bigint;
  evmCalldata: string;
  cascadeHeldAnything: boolean;
  split: { rule: SplitRule; paid: boolean; received: Record<string, bigint>; expected: bigint[] };
  refund: { status: string; amount: string; webhookType: string | null; destTx: string | null };
  agent: { status: number; body: unknown; settlement: X402Settlement | null; replayStatus: number; replayReason: string | null };
}

/**
 * Onboard `who` as a merchant: sign the NEP-413 onboarding message with their
 * own key and POST it to the API, which checks it against the chain.
 */
export async function onboardMerchant(w: World, who: Person, name: string, webhookUrl: string | null, apiUrl = w.apiUrl): Promise<{ secretKey: string; webhookSecret: string }> {
  const issuedAt = new Date().toISOString();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signed = await who.full.signNep413Message({ message: onboardingMessage({ account: who.id, name, issuedAt }), recipient: ONBOARDING_RECIPIENT, nonce });
  const r = await fetch(`${apiUrl}/v1/merchants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account: who.id, name, webhookUrl,
      proof: { signer: who.id, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString("base64"), nonce: Buffer.from(nonce).toString("base64"), issuedAt },
    }),
  });
  const j = (await r.json()) as { secretKey: string; webhookSecret: string; error?: { message: string } };
  if (r.status !== 201) throw new Error(`onboarding failed: ${j.error?.message}`);
  return j;
}

/** A tiny merchant backend: verifies Cascade webhooks with the public SDK and remembers what it accepted. */
function merchantServer(secret: () => string) {
  const accepted: WebhookEvent[] = [];
  let rejected = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        accepted.push(await verifyWebhook(raw, req.headers["cascade-signature"] as string, secret()));
        res.writeHead(200).end("ok");
      } catch {
        rejected++;
        res.writeHead(400).end("bad signature");
      }
    });
  });
  return { server, accepted, rejected: () => rejected };
}

export async function checkoutFlow(w: World, n: Narrator, opts: { dao?: string } = {}): Promise<CheckoutResult> {
  n.step("14. A ceramics studio adds Cascade Checkout to its website");
  const shop = await w.signUp("oakline");
  await w.engine.registerPerson(shop.gasless);
  n.ok(`${shop.id} signed up and registered (no fees)`);

  // The shop's own backend, which will receive webhooks.
  let webhookSecret = "";
  const m = merchantServer(() => webhookSecret);
  await new Promise<void>((r) => m.server.listen(0, "127.0.0.1", () => r()));
  const hookUrl = `http://127.0.0.1:${(m.server.address() as AddressInfo).port}/cascade-webhook`;

  const onboarded = await onboardMerchant(w, shop, "Oakline Ceramics", hookUrl);
  webhookSecret = onboarded.webhookSecret;
  n.ok(`Onboarded with a signed NEP-413 message (checked against ${shop.id}'s on-chain key). Secret key ${onboarded.secretKey.slice(0, 12)}…`);

  n.step("15. The shop's server creates a checkout session with the SDK");
  const cascade = new Cascade({ apiKey: onboarded.secretKey, baseUrl: w.apiUrl });
  const session = await cascade.checkout.create(
    { amount: "25.00", description: "Stoneware mug, 350 ml", reference: "order-1001", metadata: { sku: "MUG-STONE" } },
    { idempotencyKey: "order-1001" },
  );
  const replay = await cascade.checkout.create({ amount: "25.00", description: "Stoneware mug, 350 ml" }, { idempotencyKey: "order-1001" });
  n.say(`  const session = await cascade.checkout.create({ amount: "25.00", reference: "order-1001" })`);
  n.ok(`Session ${session.id} for $${session.amountFormatted}. Checkout page: ${session.url}`);
  n.say(`A retried request with the same idempotency key returns the same session (${replay.id === session.id ? "same id" : "DIFFERENT id"}).`);
  n.say(`On the shop's page: mountPayButton("#pay", { sessionUrl: "${session.url}" })  ->  [ Pay with any crypto ]`);

  n.step("16. The customer pays with ETH on Base from their own wallet");
  const usdcBefore = await w.usdcBalance(shop.id);
  const appBefore = await w.usdcBalance(w.engine.cfg.app);
  const pub = `${w.apiUrl}/v1/public/sessions/${session.id}`;
  const preview = (await (await fetch(`${pub}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId: ETH_BASE }) })).json()) as PaymentPreview;
  n.say(`Picks ETH on Base: ${preview.amountInFormatted} ETH (≈ $${Number(preview.amountInUsd).toFixed(2)}), shop receives exactly $${formatUsd(preview.amountOut)}`);
  const paying = (await (
    await fetch(`${pub}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId: ETH_BASE, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" }) })
  ).json()) as CheckoutSession;
  const tx = buildEvmTransfer({ chain: "base", depositAddress: paying.payment!.depositAddress, amount: paying.payment!.amountIn, tokenContract: null });
  n.say(`The page asks their wallet (EIP-1193) to send ${paying.payment!.amountInFormatted} ETH to ${tx.to} on chain ${tx.chainId}`);
  await fetch(`${w.apiUrl}/v1/public/dev/sessions/${session.id}/simulate-deposit`, { method: "POST" });
  n.say("Wallet sends; NEAR Intents swaps ETH into USDC on NEAR and delivers it to the shop (mock 1Click)");
  await w.settle();

  const done = await cascade.checkout.retrieve(session.id);
  const receipt = done.receipt ? await w.engine.reader.invoice(done.receipt.id) : null;
  const rec = (await w.store.getSession(session.id))!;
  const receiptHashMatches = receipt?.metadata_hash === Checkout.receiptHash(rec);
  const merchantUsdcDelta = (await w.usdcBalance(shop.id)) - usdcBefore;
  n.ok(`Session ${done.status}. On-chain receipt #${receipt?.id} (${receipt?.source}), bound to this session by hash: ${receiptHashMatches ? "yes" : "NO"}`);
  n.ok(`The shop's account received $${formatUsd(merchantUsdcDelta)} USDC directly; Cascade's contract never held it.`);

  n.step("17. The shop's server gets a signed webhook and ships the mug");
  for (let i = 0; i < 20 && m.accepted.length === 0; i++) await new Promise((res) => setTimeout(res, 100));
  const webhook = m.accepted[0] ?? null;
  n.ok(webhook && "session" in webhook.data ? `Verified ${webhook.type} for ${webhook.data.session.reference} with verifyWebhook(rawBody, header, secret)` : "no webhook arrived");
  const forged = await fetch(hookUrl, { method: "POST", headers: { "cascade-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: JSON.stringify({ ...webhook, id: "evt_forged" }) });
  n.say(`A forged webhook to the same endpoint is rejected (HTTP ${forged.status}).`);

  const split = await splitStory(w, n, cascade, shop, opts.dao);
  const refund = await refundStory(w, n, cascade, shop, session.id, m.accepted);
  const agent = await agentStory(w, n, cascade);
  await new Promise<void>((res) => m.server.close(() => res()));

  return {
    merchant: shop.id,
    shop,
    secretKey: onboarded.secretKey,
    session: done,
    replayedSessionId: replay.id,
    webhook,
    webhookRejectedForgery: forged.status === 400 && m.rejected() === 1,
    receipt,
    receiptHashMatches,
    merchantUsdcDelta,
    evmCalldata: tx.data,
    cascadeHeldAnything: (await w.usdcBalance(w.engine.cfg.app)) !== appBefore,
    split,
    refund,
    agent,
  };
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** 18. Every sale split on arrival between the shop, an illustrator and a DAO. */
async function splitStory(w: World, n: Narrator, cascade: Cascade, shop: Person, dao?: string): Promise<CheckoutResult["split"]> {
  n.step("18. The shop shares every sale: 80% shop, 15% the illustrator, 5% a community DAO");
  const illustrator = await w.plainAccount("illustrator");
  const community = dao ?? (await w.plainAccount("community")).id;
  const rule = expectOk(
    await shop.gasless<SplitRule>(appCalls(ids.app).createSplit(shop.id, [{ account: shop.id, bps: 8000 }, { account: illustrator.id, bps: 1500 }, { account: community, bps: 500 }])),
    "create split",
  ).value!;
  n.ok(`Split #${rule.id} is on-chain and immutable (created fee-free): ${rule.shares.map((x) => `${x.bps / 100}% ${x.account}`).join(", ")}`);
  const before = new Map(await Promise.all(rule.shares.map(async (x) => [x.account, await w.usdcBalance(x.account)] as const)));
  const s = await cascade.checkout.create({ amount: "25.00", description: "Stoneware mug, collab glaze", reference: "order-1002", splitId: rule.id });
  await post(`${w.apiUrl}/v1/public/sessions/${s.id}/pay`, { assetId: USDC_BASE, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" });
  await post(`${w.apiUrl}/v1/public/dev/sessions/${s.id}/simulate-deposit`);
  n.say(`A customer pays $25 in USDC on Base. NEAR Intents delivers it to the Cascade contract with msg {"split": ${rule.id}} (1Click customRecipientMsg).`);
  await w.settle();
  const done = await cascade.checkout.retrieve(s.id);
  const received: Record<string, bigint> = {};
  for (const x of rule.shares) received[x.account] = (await w.usdcBalance(x.account)) - before.get(x.account)!;
  const expected = splitAmount(25_000_000n, rule.shares);
  n.table(rule.shares.map((x, i) => ({ recipient: x.account, share: `${x.bps / 100}%`, received: `$${formatUsd(received[x.account]!)}`, expected: `$${formatUsd(expected[i]!)}` })));
  n.ok(`Session ${done.status}. The contract split the payment on arrival and the settler paid all three; nobody signed anything.`);
  return { rule, paid: done.status === "paid", received, expected };
}

/** 19. A partial refund, back to the customer in the coin and on the chain they paid with. */
async function refundStory(w: World, n: Narrator, cascade: Cascade, shop: Person, sessionId: string, hooks: WebhookEvent[]): Promise<CheckoutResult["refund"]> {
  n.step("19. A customer asks for $10 back on order-1001: refunded as ETH on Base, to their own address");
  const r1 = await cascade.refunds.create(sessionId, { amount: "10.00" });
  n.say(`Cascade quotes the payout and locks it as one line to ${r1.lines[0]!.dest}. The shop signs create_batch with its own key (fee-free).`);
  const created = expectOk(await shop.gasless<CreatedBatch>(appCalls(ids.app).createBatch(shop.id, r1.lines as LineInput[])), "refund batch").value!;
  const r2 = await cascade.refunds.confirm(r1.id, created.id);
  n.say(`Cascade checks batch #${created.id} on-chain (owner and hash) and returns the funding call; the shop signs it.`);
  const fund = r2.calls[0]!;
  expectOk(await shop.gaslessFull(ftCalls(fund.receiverId).fundBatch(ids.app, BigInt(fund.args.amount as string), JSON.parse(fund.args.msg as string))), "fund refund");
  await w.settle();
  for (let i = 0; i < 30 && !hooks.some((e) => e.type.startsWith("refund.")); i++) await new Promise((res) => setTimeout(res, 100));
  const r3 = await cascade.refunds.retrieve(r1.id);
  const hook = hooks.find((e) => e.type.startsWith("refund.")) ?? null;
  n.ok(`Refund ${r3.status}: $${formatUsd(r3.amount)} delivered as ETH on Base (tx ${r3.destTx?.slice(0, 12)}…). Webhook: ${hook?.type ?? "none"}`);
  return { status: r3.status, amount: r3.amount, webhookType: hook?.type ?? null, destTx: r3.destTx };
}

/** 20. An AI agent pays for one API call over HTTP 402 (x402 v2). */
async function agentStory(w: World, n: Narrator, cascade: Cascade): Promise<CheckoutResult["agent"]> {
  n.step("20. An AI agent buys from the shop's paid API over HTTP 402 (x402)");
  const guard = x402Guard(cascade, { price: "0.10", description: "3-day forecast", assets: [USDC_BASE, ETH_BASE] });
  const handler = async (req: Request) => {
    const g = await guard(req);
    return g.paid ? Response.json({ city: "Lisbon", sky: ["sun", "cloud", "rain"] }, { headers: g.headers }) : g.response;
  };
  let lastSig: string | null = null;
  const agentFetch: typeof fetch = async (u, init) => {
    const req = new Request(String(u), init);
    lastSig = req.headers.get(X402_HEADERS.signature) ?? lastSig;
    return handler(req);
  };
  let settling: Promise<unknown> = Promise.resolve();
  const res = await fetchWithPayment("https://oakline.example/api/forecast", {}, {
    fetch: agentFetch,
    refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
    pollMs: 300,
    choose: (accepts) => {
      n.say(`402 Payment Required, payable with ${accepts.map((a) => `${a.extra.symbol} on ${a.extra.chain} (${a.network})`).join(" or ")}`);
      return accepts.find((a) => a.extra.symbol === "ETH")!;
    },
    pay: async (req) => {
      const sim = (await (await post(`${w.apiUrl}/v1/public/dev/deposits/${req.payTo}/simulate`)).json()) as { txHash: string };
      n.say(`The agent sends ${req.amount} wei of ETH on Base and retries with PAYMENT-SIGNATURE until it settles`);
      settling = w.settle();
      return sim.txHash;
    },
  });
  await settling;
  const header = res.headers.get(X402_HEADERS.response);
  const body = await res.json();
  n.ok(`HTTP ${res.status}: ${JSON.stringify(body)}. The shop received exactly $0.10 in USDC on NEAR.`);
  const replay = await handler(new Request("https://oakline.example/api/forecast", { headers: { [X402_HEADERS.signature]: lastSig! } }));
  const rh = replay.headers.get(X402_HEADERS.response);
  const replayReason = rh ? (decodeHeader<X402Settlement>(rh).errorReason ?? null) : null;
  n.say(`Replaying the same payment gets HTTP ${replay.status} (${replayReason}): one payment, one response.`);
  return { status: res.status, body, settlement: header ? decodeHeader<X402Settlement>(header) : null, replayStatus: replay.status, replayReason };
}
