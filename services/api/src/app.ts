import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { RateLimiter, HOUR, type Limiter } from "@cascade/core";
import { AgentPayments, Billing, CheckoutError, Refunds, type Checkout, type OnboardingProof } from "@cascade/engine";
import { ledgerRows, toCsv } from "@cascade/db";
import type { X402PaymentPayload } from "@cascade/sdk";
import type { MockOneClick } from "@cascade/oneclick";

export interface ApiOptions {
  checkout: Checkout;
  refunds?: Refunds;
  agents?: AgentPayments;
  /** Invoices, plans, subscriptions, customers. Pass the same instance the settler ticks. */
  billing?: Billing;
  trustProxy?: boolean;
  /** Sandbox only: enables POST /v1/dev/... routes that fake a payer's deposit. */
  dev?: { oneclick: MockOneClick };
  limiter?: Limiter;
  /** A header the platform sets to the client IP ("cf-connecting-ip" on Cloudflare). Checked before x-forwarded-for. */
  ipHeader?: string;
}

type Json = Record<string, unknown>;

/**
 * Cascade Checkout API.
 *   Merchant (secret key, server-to-server): /v1/merchant, /v1/checkout/sessions
 *   Public (checkout page, keyed by the unguessable session id): /v1/public/...
 */
export function apiApp(o: ApiOptions) {
  const app = new Hono();
  const c = o.checkout;
  const refunds = o.refunds ?? new Refunds(c);
  const agents = o.agents ?? new AgentPayments(c);
  const billing = o.billing ?? new Billing(c);
  const limiter = o.limiter ?? new RateLimiter();
  const ip = (ctx: Context) => (o.ipHeader ? ctx.req.header(o.ipHeader) : undefined) ?? (o.trustProxy ? ctx.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? ctx.req.header("x-real-ip") ?? "local";
  const body = async (ctx: Context): Promise<Json> => {
    const j = await ctx.req.json().catch(() => null);
    if (!j || typeof j !== "object") throw new CheckoutError(400, "body must be a JSON object");
    return j as Json;
  };
  const str = (v: unknown, name: string, required = true): string | undefined => {
    if (v === undefined || v === null) {
      if (required) throw new CheckoutError(400, `${name} is required`);
      return undefined;
    }
    if (typeof v !== "string") throw new CheckoutError(400, `${name} must be a string`);
    return v;
  };

  app.onError((err, ctx) => {
    if (err instanceof CheckoutError) return ctx.json({ error: { message: err.message } }, err.status as 400);
    console.error(err);
    return ctx.json({ error: { message: "internal error" } }, 500);
  });

  app.get("/health", (ctx) => ctx.json({ ok: true }));

  // ------------------------------------------------------------ onboarding (public, signed)
  app.post("/v1/merchants", async (ctx) => {
    if (!(await limiter.take(`onboard:${ip(ctx)}`, { max: 10, windowMs: HOUR }))) throw new CheckoutError(429, "too many attempts");
    const b = await body(ctx);
    const proof = b.proof as OnboardingProof | undefined;
    if (!proof || typeof proof !== "object") throw new CheckoutError(400, "proof is required");
    const { merchant, secretKey } = await c.onboard({
      account: str(b.account, "account")!,
      name: str(b.name, "name")!,
      webhookUrl: str(b.webhookUrl, "webhookUrl", false) ?? null,
      proof,
    });
    return ctx.json(
      { merchant: { id: merchant.id, account: merchant.account, name: merchant.name, webhookUrl: merchant.webhookUrl }, secretKey, webhookSecret: merchant.webhookSecret },
      201,
    );
  });

  // ------------------------------------------------------------ merchant (secret key)
  const merchant = new Hono();
  // Scoped to merchant paths only: a "*" here would also catch /v1/public.
  const auth = async (ctx: Context, next: () => Promise<void>) => {
    const k = await c.authenticateKey(ctx.req.header("authorization"));
    // Read-only keys (rk_...) can look but not act.
    if (k.role === "read" && ctx.req.method !== "GET") throw new CheckoutError(403, "this is a read-only key");
    ctx.set("merchant" as never, k.merchant as never);
    ctx.set("keyHash" as never, k.hash as never);
    await next();
  };
  merchant.use("/merchant", auth);
  merchant.use("/merchant/*", auth);
  merchant.use("/checkout/*", auth);
  merchant.use("/refunds/*", auth);
  merchant.use("/x402/*", auth);
  merchant.use("/webhooks", auth);
  merchant.use("/webhooks/*", auth);
  merchant.use("/reports/*", auth);
  for (const p of ["/invoices", "/invoices/*", "/plans", "/plans/*", "/subscriptions", "/subscriptions/*", "/customers"]) merchant.use(p, auth);
  const me = (ctx: Context) => ctx.get("merchant" as never) as unknown as Awaited<ReturnType<Checkout["authenticate"]>>;

  /** The merchant's USDC balance on NEAR, read from the token contract. */
  merchant.get("/merchant/balance", async (ctx) => {
    const m = me(ctx);
    const token = (await c.reader.config()).token;
    return ctx.json({ account: m.account, token, usdc: (await c.cfg.chain.ftBalance(token, m.account)).toString() });
  });
  merchant.get("/merchant", (ctx) => {
    const m = me(ctx);
    return ctx.json({ id: m.id, name: m.name, account: m.account, webhookUrl: m.webhookUrl, payout: m.payout ?? null });
  });
  // ------------------------------------------------------------ money out (read from the chain)
  merchant.get("/merchant/escrows", async (ctx) => ctx.json({ object: "list", data: await c.reader.escrowsFor(me(ctx).account) }));
  merchant.get("/merchant/agents", async (ctx) => ctx.json({ object: "list", data: await c.reader.allowances(me(ctx).account) }));
  merchant.get("/merchant/payouts", async (ctx) => {
    const docs = (await c.cfg.store.listBatches(me(ctx).account)).slice(-50).reverse();
    const data = await Promise.all(docs.map(async (d) => {
      const b = await c.reader.batch(d.id).catch(() => null);
      return {
        id: d.id, title: d.title, createdAt: d.createdAt, lines: d.lines.length,
        total: d.lines.reduce((t, l) => t + BigInt(l.amount), 0n).toString(),
        recipients: d.lines.map((l) => ({ name: l.name, chain: l.chain, address: l.address, amount: l.amount })),
        status: b?.status ?? "Unknown", buckets: b?.buckets ?? null, dao: d.ownerKind === "Dao",
      };
    }));
    return ctx.json({ object: "list", data });
  });
  merchant.get("/merchant/splits", async (ctx) => ctx.json({ object: "list", data: await c.listSplits(me(ctx)) }));
  merchant.post("/merchant/splits", async (ctx) => {
    const b = await body(ctx);
    return ctx.json(await c.registerSplit(me(ctx), Number(b.id)), 201);
  });
  merchant.get("/merchant/keys", async (ctx) => ctx.json({ object: "list", data: await c.listKeys(me(ctx)) }));
  merchant.post("/merchant/keys", async (ctx) => {
    const b = await body(ctx);
    const role = (str(b.role, "role", false) ?? "read") as "full" | "read";
    const key = await c.issueKey(me(ctx).id, role, str(b.label, "label", false) ?? null);
    return ctx.json({ key, role, prefix: key.slice(0, 14) }, 201);
  });
  merchant.post("/merchant/keys/:prefix/revoke", async (ctx) => {
    await c.revokeKey(me(ctx), ctx.req.param("prefix"), ctx.get("keyHash" as never) as unknown as string);
    return ctx.json({ revoked: true });
  });
  merchant.post("/merchant/payout", async (ctx) => {
    const b = await body(ctx);
    const proof = b.proof as OnboardingProof | undefined;
    if (!proof || typeof proof !== "object") throw new CheckoutError(400, "proof is required: a NEP-413 signature of the payout message");
    const raw = b.payout as { chain?: unknown; address?: unknown } | null | undefined;
    if (raw === undefined) throw new CheckoutError(400, "payout is required (null for USDC on NEAR)");
    const payout = raw === null ? null : { chain: str(raw.chain, "payout.chain")!, address: str(raw.address, "payout.address")! };
    const m = await c.setPayout(me(ctx), payout, proof);
    return ctx.json({ payout: m.payout ?? null });
  });
  merchant.post("/merchant", async (ctx) => {
    const b = await body(ctx);
    const m = await c.updateMerchant(me(ctx), {
      ...(b.name !== undefined ? { name: str(b.name, "name")! } : {}),
      ...(b.webhookUrl !== undefined ? { webhookUrl: (str(b.webhookUrl, "webhookUrl", false) ?? null) } : {}),
    });
    return ctx.json({ id: m.id, name: m.name, account: m.account, webhookUrl: m.webhookUrl });
  });
  merchant.post("/checkout/sessions", async (ctx) => {
    const m = me(ctx);
    if (!(await limiter.take(`sessions:${m.id}`, { max: 1000, windowMs: HOUR }))) throw new CheckoutError(429, "session rate limit");
    const b = await body(ctx);
    const s = await c.createSession(
      m,
      {
        amount: str(b.amount, "amount")!,
        description: str(b.description, "description")!,
        ...(b.reference !== undefined ? { reference: str(b.reference, "reference")! } : {}),
        ...(b.metadata !== undefined ? { metadata: b.metadata as Record<string, string> } : {}),
        ...(b.successUrl !== undefined ? { successUrl: str(b.successUrl, "successUrl")! } : {}),
        ...(b.cancelUrl !== undefined ? { cancelUrl: str(b.cancelUrl, "cancelUrl")! } : {}),
        ...(typeof b.expiresInMinutes === "number" ? { expiresInMinutes: b.expiresInMinutes } : {}),
        ...(b.splitId !== undefined ? { splitId: Number(b.splitId) } : {}),
        ...(b.escrowId !== undefined ? { escrowId: Number(b.escrowId) } : {}),
      },
      ctx.req.header("idempotency-key") ?? undefined,
    );
    return ctx.json(await c.view(s), 201);
  });
  merchant.get("/checkout/sessions", async (ctx) => {
    const limit = Math.min(Number(ctx.req.query("limit") ?? 20) || 20, 100);
    const list = await c.cfg.store.listSessions(me(ctx).id, limit);
    return ctx.json({ data: await Promise.all(list.map((s) => c.view(s))) });
  });
  merchant.get("/checkout/sessions/:id", async (ctx) => {
    const s = await c.getSession(ctx.req.param("id"));
    if (s.merchantId !== me(ctx).id) throw new CheckoutError(404, "no such checkout session");
    return ctx.json(await c.view(s));
  });

  // Refunds: prepare -> merchant signs create_batch -> confirm -> merchant signs funding.
  merchant.post("/checkout/sessions/:id/refunds", async (ctx) => {
    const b = await body(ctx).catch(() => ({}) as Json);
    const r = await refunds.prepare(me(ctx), ctx.req.param("id"), str(b.amount, "amount", false));
    return ctx.json(await refunds.view(r), 201);
  });
  merchant.post("/refunds/:id/confirm", async (ctx) => {
    const b = await body(ctx);
    if (typeof b.batchId !== "number") throw new CheckoutError(400, "batchId (number) is required");
    return ctx.json(await refunds.view(await refunds.confirm(me(ctx), ctx.req.param("id"), b.batchId)));
  });
  merchant.get("/refunds/:id", async (ctx) => ctx.json(await refunds.view(await refunds.get(me(ctx), ctx.req.param("id")))));

  // x402 facilitator (called by the merchant's server through @cascade/sdk x402Guard).
  merchant.post("/x402/prepare", async (ctx) => {
    const b = await body(ctx);
    return ctx.json(
      await agents.prepare(me(ctx), {
        amount: str(b.amount, "amount")!, description: str(b.description, "description")!, resource: str(b.resource, "resource")!, url: str(b.url, "url")!,
        ...(b.mimeType !== undefined ? { mimeType: str(b.mimeType, "mimeType")! } : {}),
        ...(Array.isArray(b.assets) ? { assets: b.assets.map((a) => String(a)) } : {}),
        ...(b.refundTo !== undefined ? { refundTo: str(b.refundTo, "refundTo")! } : {}),
      }),
    );
  });
  merchant.post("/x402/settle", async (ctx) => {
    const b = await body(ctx);
    return ctx.json(await agents.settle(me(ctx), { payload: b.payload as X402PaymentPayload, resource: str(b.resource, "resource")! }));
  });

  // Operations: webhook log and retries, accountant CSV.
  merchant.get("/webhooks", async (ctx) => {
    const list = await c.cfg.store.listWebhooks(me(ctx).id);
    return ctx.json({ data: list.map(({ body: _b, ...w }) => w).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });
  merchant.post("/webhooks/:id/retry", async (ctx) => {
    const w = await c.cfg.store.getWebhook(ctx.req.param("id"));
    if (!w || w.merchantId !== me(ctx).id) throw new CheckoutError(404, "no such webhook");
    await c.cfg.store.putWebhook({ ...w, status: "pending", nextAttemptAt: new Date(0).toISOString() });
    return ctx.json({ ok: true });
  });
  merchant.get("/reports/ledger.csv", async (ctx) => {
    const month = ctx.req.query("month");
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new CheckoutError(400, "month must be YYYY-MM");
    const rows = await ledgerRows(c.cfg.store, me(ctx).account, { ...(month ? { month } : {}), chain: { batch: (id) => c.reader.batch(id), lines: (id) => c.reader.lines(id) } });
    return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="cascade-${month ?? "all"}.csv"` } });
  });

  // ------------------------------------------------------------ billing
  const list = <T>(data: T[]) => ({ object: "list", data });
  const int = (v: unknown, name: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v)) throw new CheckoutError(400, `${name} must be an integer`);
    return v;
  };
  merchant.post("/invoices", async (ctx) => {
    const b = await body(ctx);
    const daysUntilDue = int(b.daysUntilDue, "daysUntilDue");
    const inv = await billing.createInvoice(me(ctx), {
      customer: b.customer, items: b.items,
      ...(b.dueDate !== undefined ? { dueDate: str(b.dueDate, "dueDate")! } : {}),
      ...(daysUntilDue !== undefined ? { daysUntilDue } : {}),
      ...(b.memo !== undefined ? { memo: str(b.memo, "memo")! } : {}),
    });
    return ctx.json(await billing.invoiceView(inv), 201);
  });
  merchant.get("/invoices", async (ctx) => ctx.json(list(await Promise.all((await billing.listInvoices(me(ctx))).map((i) => billing.invoiceView(i))))));
  merchant.get("/invoices/:id", async (ctx) => ctx.json(await billing.invoiceView(await billing.getInvoice(me(ctx), ctx.req.param("id")))));
  merchant.post("/invoices/:id/void", async (ctx) => ctx.json(await billing.invoiceView(await billing.voidInvoice(me(ctx), ctx.req.param("id")))));
  merchant.post("/plans", async (ctx) => ctx.json(billing.planView(await billing.createPlan(me(ctx), await body(ctx))), 201));
  merchant.get("/plans", async (ctx) => ctx.json(list((await billing.listPlans(me(ctx))).map((p) => billing.planView(p)))));
  merchant.post("/subscriptions", async (ctx) => {
    const b = await body(ctx);
    const s = await billing.createSubscription(me(ctx), { planId: b.planId, customer: b.customer, prepaidPeriods: b.prepaidPeriods });
    const inv = await billing.getInvoice(me(ctx), s.latestInvoiceId!);
    return ctx.json({ ...(await billing.subscriptionView(s)), latestInvoice: await billing.invoiceView(inv) }, 201);
  });
  merchant.get("/subscriptions", async (ctx) => ctx.json(list(await Promise.all((await billing.listSubscriptions(me(ctx))).map((s) => billing.subscriptionView(s))))));
  merchant.get("/subscriptions/:id", async (ctx) => ctx.json(await billing.subscriptionView(await billing.getSubscription(me(ctx), ctx.req.param("id")))));
  merchant.post("/subscriptions/:id/cancel", async (ctx) => {
    const b = (await ctx.req.json().catch(() => ({}))) as { atPeriodEnd?: unknown };
    return ctx.json(await billing.subscriptionView(await billing.cancelSubscription(me(ctx), ctx.req.param("id"), b.atPeriodEnd === true)));
  });
  merchant.get("/customers", async (ctx) => ctx.json(list(await billing.customers(me(ctx)))));

  app.route("/v1", merchant);

  // ------------------------------------------------------------ public (checkout page)
  const pub = new Hono();
  pub.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"], allowHeaders: ["content-type"] }));
  pub.use("*", async (ctx, next) => {
    if (!(await limiter.take(`public:${ip(ctx)}`, { max: 600, windowMs: HOUR }))) throw new CheckoutError(429, "too many requests");
    await next();
  });
  pub.get("/assets", async (ctx) => ctx.json({ data: await c.assets() }));
  pub.get("/sessions/:id", async (ctx) => ctx.json(await c.view(await c.getSession(ctx.req.param("id")))));
  pub.post("/sessions/:id/preview", async (ctx) => {
    const b = await body(ctx);
    return ctx.json(await c.preview(ctx.req.param("id"), str(b.assetId, "assetId")!));
  });
  pub.post("/sessions/:id/pay", async (ctx) => {
    const b = await body(ctx);
    return ctx.json(await c.startPayment(ctx.req.param("id"), { assetId: str(b.assetId, "assetId")!, refundTo: str(b.refundTo, "refundTo")! }));
  });
  pub.get("/sessions/:id/receipt", async (ctx) => ctx.json(await c.receipt(ctx.req.param("id"))));
  pub.get("/invoices/:id", async (ctx) => ctx.json(await billing.publicInvoice(ctx.req.param("id"))));
  pub.post("/invoices/:id/pay", async (ctx) => ctx.json(await billing.payInvoice(ctx.req.param("id"))));
  pub.post("/sessions/:id/deposit", async (ctx) => {
    const b = await body(ctx);
    return ctx.json(await c.submitDeposit(ctx.req.param("id"), str(b.txHash, "txHash")!));
  });
  if (o.dev) {
    const mock = o.dev.oneclick;
    pub.post("/dev/sessions/:id/simulate-deposit", async (ctx) => {
      const s = await c.getSession(ctx.req.param("id"));
      const dep = s.attempts.at(-1);
      if (!dep) throw new CheckoutError(400, "start a payment first");
      await mock.simulatePayerDeposit(dep);
      return ctx.json(await c.view(s));
    });
    // Agents in the sandbox pay a deposit address directly (x402).
    pub.post("/dev/deposits/:address/simulate", async (ctx) => {
      const r = await mock.simulatePayerDeposit(ctx.req.param("address"));
      return ctx.json({ status: r.status, txHash: r.swapDetails.originChainTxHashes[0]?.hash ?? null });
    });
  }
  app.route("/v1/public", pub);

  return app;
}
