/**
 * Operator view, for the team only.
 *
 *   GET  /api/admin/overview            stats, applications, merchants (Bearer CASCADE_ADMIN_TOKEN)
 *   POST /api/admin/applications/:id    {status, note?}: move an application through review
 *
 * Off unless CASCADE_ADMIN_TOKEN is set (a Worker secret, never committed).
 * Wrong tokens are rate-limited per IP, and the comparison hashes both sides
 * first so it takes the same time whatever the input.
 */
import { Hono, type Context } from "hono";
import { HOUR, type Limiter } from "@cascade/core";
import type { Store } from "@cascade/db";
import { APPLICATION_STATUSES, type Application, type ApplicationStatus } from "./access.js";

export interface AdminOptions {
  store: Store;
  limiter: Limiter;
  token: string | null;
  network: string;
  feeBps: number;
  ipHeader?: string;
}

const enc = new TextEncoder();
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x!.length; i++) diff |= x![i]! ^ y![i]!;
  return diff === 0;
}

const usd = (base: bigint) => Number(base) / 1e6;

export function adminApp(o: AdminOptions) {
  const app = new Hono();
  const ip = (c: Context) => (o.ipHeader ? c.req.header(o.ipHeader) : undefined) ?? c.req.header("x-real-ip") ?? "local";

  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    if (!o.token) return c.json({ error: { message: "not found" } }, 404);
    if (!(await o.limiter.peek(`admin:${ip(c)}`, { max: 10, windowMs: HOUR }))) return c.json({ error: { message: "too many attempts, try later" } }, 429);
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!(await sameSecret(given, o.token))) {
      await o.limiter.take(`admin:${ip(c)}`, { max: 10, windowMs: HOUR });
      return c.json({ error: { message: "wrong admin token" } }, 401);
    }
    await next();
  });

  app.get("/overview", async (c) => {
    const merchants = await o.store.listMerchants();
    const day = Date.now() - 86_400_000;
    let sessions = 0, paid = 0, volume = 0n, paid24h = 0, volume24h = 0n;
    const rows = [];
    for (const m of merchants) {
      const list = await o.store.listSessions(m.id, 1000);
      let mPaid = 0, mVol = 0n, last: string | null = null;
      for (const s of list) {
        sessions++;
        if (!last || s.createdAt > last) last = s.createdAt;
        if (s.status !== "paid") continue;
        paid++; mPaid++;
        const a = BigInt(s.amount);
        volume += a; mVol += a;
        if (s.paidAt && Date.parse(s.paidAt) >= day) { paid24h++; volume24h += a; }
      }
      rows.push({
        id: m.id, name: m.name, account: m.account, createdAt: m.createdAt,
        sandbox: /^sbx-/.test(m.account), webhook: !!m.webhookUrl,
        payout: m.payout ? `${m.payout.chain}` : "near",
        sessions: list.length, paid: mPaid, volumeUsd: usd(mVol), lastActivity: last,
      });
    }
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const [applications, invoices, subscriptions, refunds] = await Promise.all([
      o.store.listDocs<Application>("application"),
      o.store.listDocs<unknown>("invoice"),
      o.store.listDocs<{ status?: string }>("subscription"),
      o.store.listOpenRefunds(),
    ]);
    return c.json({
      network: o.network,
      feeBps: o.feeBps,
      generatedAt: new Date().toISOString(),
      stats: {
        merchants: merchants.length,
        sandboxMerchants: rows.filter((r) => r.sandbox).length,
        applications: applications.length,
        newApplications: applications.filter((a) => a.status === "received").length,
        sessions, paid, volumeUsd: usd(volume), paid24h, volume24hUsd: usd(volume24h),
        feesUsd: usd((volume * BigInt(o.feeBps)) / 10_000n),
        invoices: invoices.length,
        activeSubscriptions: subscriptions.filter((s) => s.status === "active").length,
        openRefunds: refunds.length,
      },
      applications: applications.reverse(),
      merchants: rows,
    });
  });

  app.post("/applications/:id", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.json().catch(() => ({}))) as { status?: unknown; note?: unknown };
    if (!APPLICATION_STATUSES.includes(b.status as ApplicationStatus)) return c.json({ error: { message: `status must be one of ${APPLICATION_STATUSES.join(", ")}` } }, 400);
    const a = await o.store.getDoc<Application>("application", id);
    if (!a) return c.json({ error: { message: "no such application" } }, 404);
    const next: Application = {
      ...a, status: b.status as ApplicationStatus, reviewedAt: new Date().toISOString(),
      ...(typeof b.note === "string" ? { note: b.note.trim().slice(0, 500) || null } : {}),
    };
    await o.store.putDoc("application", id, "applications", next);
    return c.json(next);
  });

  return app;
}
