/**
 * Self-serve access.
 *
 *   POST /api/sandbox/merchant   instant sandbox merchant (testnet demo mode only)
 *   POST /api/apply              apply for live access (companies; reviewed before keys are issued)
 *
 * A sandbox merchant is a real testnet NEAR account (created by the factory,
 * paid for by the relayer), registered with Cascade and onboarded with its own
 * NEP-413 signature, exactly like a production merchant. The visitor gets the
 * secret key and the account's key: it is theirs, on testnet only.
 */
import { Hono, type Context } from "hono";
import { DAY, type Limiter } from "@cascade/core";
import type { Store } from "@cascade/db";
import { CheckoutError, ONBOARDING_RECIPIENT, onboardingMessage, randomId, type Checkout } from "@cascade/engine";
import { appCalls, signMeta, type Chain } from "@cascade/near";
import { RelayError, type Relayer } from "@cascade/relayer";
import { KeyPair } from "near-api-js";

export interface AccessOptions {
  checkout: Checkout;
  relayer: Relayer;
  chain: Chain;
  app: string;
  store: Store;
  limiter: Limiter;
  /** Sandbox merchants are only offered in testnet demo mode. */
  sandbox: boolean;
  ipHeader?: string;
}

export const APPLICATION_STATUSES = ["received", "reviewing", "approved", "rejected"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface Application {
  id: string;
  company: string;
  website: string | null;
  email: string;
  country: string | null;
  monthlyVolume: string | null;
  useCase: string;
  nearAccount: string | null;
  status: ApplicationStatus;
  /** Set by the operator in /admin. */
  reviewedAt?: string | null;
  note?: string | null;
  createdAt: string;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function accessApp(o: AccessOptions) {
  const app = new Hono();
  const ip = (c: Context) => (o.ipHeader ? c.req.header(o.ipHeader) : undefined) ?? c.req.header("x-real-ip") ?? "local";

  app.onError((err, c) => {
    if (err instanceof CheckoutError || err instanceof RelayError) return c.json({ error: { message: err.message } }, err.status as 400);
    console.error("access", err);
    return c.json({ error: { message: err instanceof Error ? err.message : "internal error" } }, 500);
  });

  app.get("/sandbox", (c) => c.json({ available: o.sandbox }));

  app.post("/sandbox/merchant", async (c) => {
    if (!o.sandbox) throw new CheckoutError(404, "sandbox accounts are available on the testnet demo only");
    if (!(await o.limiter.take(`sandbox:${ip(c)}`, { max: 3, windowMs: DAY }))) throw new CheckoutError(429, "too many sandbox accounts from this address today");
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const business = clean(b.name, 80) || "My test business";
    if (business.length < 2) throw new CheckoutError(400, "business name must be at least 2 characters");

    // 1. A real testnet account, from the factory (the relayer pays).
    const key = KeyPair.fromRandom("ed25519");
    const name = `sbx-${randomId("", 8).toLowerCase()}`;
    const created = await o.relayer.createName({ name, publicKey: key.getPublicKey().toString() }, { ip: ip(c) });
    const account = o.chain.account(created.accountId, key.toString() as never);

    // 2. Register with Cascade, fee-free (NEP-366, signed by the new account).
    const reg = await o.relayer.relay(await signMeta(account, appCalls(o.app).registerOwner("Account", [])), { ip: ip(c) });
    if (!reg.ok) throw new CheckoutError(502, `registration failed: ${reg.error ?? "unknown"}`);

    // 3. Onboard with its own NEP-413 signature, like any merchant.
    const issuedAt = new Date().toISOString();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const signed = await account.signNep413Message({ message: onboardingMessage({ account: created.accountId, name: business, issuedAt }), recipient: ONBOARDING_RECIPIENT, nonce });
    const { merchant, secretKey } = await o.checkout.onboard({
      account: created.accountId, name: business, webhookUrl: null,
      proof: { signer: created.accountId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString("base64"), nonce: Buffer.from(nonce).toString("base64"), issuedAt },
    });
    return c.json({ merchant: { id: merchant.id, name: merchant.name, account: merchant.account }, secretKey, accountKey: key.toString(), network: o.chain.networkId }, 201);
  });

  app.post("/apply", async (c) => {
    if (!(await o.limiter.take(`apply:${ip(c)}`, { max: 10, windowMs: DAY }))) throw new CheckoutError(429, "too many applications from this address today");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = clean(b.email, 200);
    const company = clean(b.company, 120);
    const useCase = clean(b.useCase, 2000);
    if (company.length < 2) throw new CheckoutError(400, "company is required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new CheckoutError(400, "a valid email is required");
    if (useCase.length < 10) throw new CheckoutError(400, "tell us briefly what you will use Cascade for");
    const a: Application = {
      id: randomId("app_"), company, email, useCase,
      website: clean(b.website, 200) || null, country: clean(b.country, 80) || null,
      monthlyVolume: clean(b.monthlyVolume, 40) || null, nearAccount: clean(b.nearAccount, 64) || null,
      status: "received", createdAt: new Date().toISOString(),
    };
    await o.store.putDoc("application", a.id, "applications", a);
    return c.json({ id: a.id, status: a.status }, 201);
  });

  return app;
}
