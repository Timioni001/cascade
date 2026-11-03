/**
 * The merchant story: a print shop in Lagos sells a poster to a customer who
 * pays in ETH on Base. Everything a real integration touches is real here:
 * an NEP-413 signature checked against the shop's on-chain key, the checkout
 * API over HTTP, the public SDK, a merchant webhook server that verifies
 * signatures, and the on-chain receipt. Only 1Click is mocked.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { formatUsd, type Invoice } from "@cascade/core";
import { Checkout, ONBOARDING_RECIPIENT, onboardingMessage } from "@cascade/engine";
import { Cascade, buildEvmTransfer, verifyWebhook, type CheckoutSession, type PaymentPreview, type WebhookEvent } from "@cascade/sdk";
import type { Narrator } from "./flows.js";
import type { Person, World } from "./world.js";

const ETH_BASE = "nep141:base.omft.near";

export interface CheckoutResult {
  merchant: string;
  session: CheckoutSession;
  replayedSessionId: string;
  webhook: WebhookEvent | null;
  webhookRejectedForgery: boolean;
  receipt: Invoice | null;
  receiptHashMatches: boolean;
  merchantUsdcDelta: bigint;
  evmCalldata: string;
  cascadeHeldAnything: boolean;
}

/**
 * Onboard `who` as a merchant: sign the NEP-413 onboarding message with their
 * own key and POST it to the API, which checks it against the chain.
 */
export async function onboardMerchant(w: World, who: Person, name: string, webhookUrl: string | null): Promise<{ secretKey: string; webhookSecret: string }> {
  const issuedAt = new Date().toISOString();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signed = await who.full.signNep413Message({ message: onboardingMessage({ account: who.id, name, issuedAt }), recipient: ONBOARDING_RECIPIENT, nonce });
  const r = await fetch(`${w.apiUrl}/v1/merchants`, {
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

export async function checkoutFlow(w: World, n: Narrator): Promise<CheckoutResult> {
  n.step("14. A print shop adds Cascade Checkout to its website");
  const shop = await w.signUp("lagos-prints");
  await w.engine.registerPerson(shop.gasless);
  n.ok(`${shop.id} signed up and registered (no fees)`);

  // The shop's own backend, which will receive webhooks.
  let webhookSecret = "";
  const m = merchantServer(() => webhookSecret);
  await new Promise<void>((r) => m.server.listen(0, "127.0.0.1", () => r()));
  const hookUrl = `http://127.0.0.1:${(m.server.address() as AddressInfo).port}/cascade-webhook`;

  const onboarded = await onboardMerchant(w, shop, "Lagos Prints", hookUrl);
  webhookSecret = onboarded.webhookSecret;
  n.ok(`Onboarded with a signed NEP-413 message (checked against ${shop.id}'s on-chain key). Secret key ${onboarded.secretKey.slice(0, 12)}…`);

  n.step("15. The shop's server creates a checkout session with the SDK");
  const cascade = new Cascade({ apiKey: onboarded.secretKey, baseUrl: w.apiUrl });
  const session = await cascade.checkout.create(
    { amount: "25.00", description: "A2 poster, 'Lagos at dusk'", reference: "order-1001", metadata: { sku: "A2-DUSK" } },
    { idempotencyKey: "order-1001" },
  );
  const replay = await cascade.checkout.create({ amount: "25.00", description: "A2 poster, 'Lagos at dusk'" }, { idempotencyKey: "order-1001" });
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

  n.step("17. The shop's server gets a signed webhook and ships the poster");
  for (let i = 0; i < 20 && m.accepted.length === 0; i++) await new Promise((res) => setTimeout(res, 100));
  const webhook = m.accepted[0] ?? null;
  n.ok(webhook ? `Verified ${webhook.type} for ${webhook.data.session.reference} with verifyWebhook(rawBody, header, secret)` : "no webhook arrived");
  const forged = await fetch(hookUrl, { method: "POST", headers: { "cascade-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: JSON.stringify({ ...webhook, id: "evt_forged" }) });
  n.say(`A forged webhook to the same endpoint is rejected (HTTP ${forged.status}).`);
  await new Promise<void>((res) => m.server.close(() => res()));

  return {
    merchant: shop.id,
    session: done,
    replayedSessionId: replay.id,
    webhook,
    webhookRejectedForgery: forged.status === 400 && m.rejected() === 1,
    receipt,
    receiptHashMatches,
    merchantUsdcDelta,
    evmCalldata: tx.data,
    cascadeHeldAnything: (await w.usdcBalance(w.engine.cfg.app)) !== appBefore,
  };
}
