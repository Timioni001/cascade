/**
 * Cascade on Cloudflare: one Worker serves the web app (static assets), the
 * checkout API, the relayer and the demo shop, with D1 as the database. The
 * settler runs from a cron trigger every minute and, so a payment confirms in
 * seconds rather than a minute, also right after the checkout page polls (at
 * most one tick at a time, under a lease in D1).
 *
 * Same platform code as the Node server (services/platform); only the
 * hosting differs. Setup: docs/hosting.md.
 */
import { D1Store, type D1Like } from "@cascade/db";
import type { MockRecord } from "@cascade/oneclick";
import { ConfigError, createPlatform, parseConfig, webAssetPath, webHeaders, type Platform, type ShopOrder } from "@cascade/platform";

interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}
export interface WorkerEnv {
  DB: D1Like;
  ASSETS: Fetcher;
  [k: string]: unknown;
}

/** Settler ticks: at most one at a time; after a poll at most every few seconds. */
const TICK_LEASE_MS = 4_000;
/** Routes after which an extra settler tick helps: what the checkout page and paying agents poll, and the demo's simulated deposit. */
const NUDGE = /^\/v1\/public\/sessions\/[^/]+$|^\/v1\/public\/dev\/|^\/v1\/x402\/settle$|^\/api\/shop\/forecast$/;

let cached: { key: string; platform: Platform; store: D1Store } | null = null;

function platformFor(env: WorkerEnv): { platform: Platform; store: D1Store } {
  const vars = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const key = JSON.stringify(vars);
  if (cached?.key === key) return cached;
  const cfg = parseConfig(vars, {}, "the Worker's vars (wrangler.jsonc)");
  const store = new D1Store(env.DB);
  const mocks = store.kv<MockRecord>("mock-1click");
  const shop = store.kv<ShopOrder>("shop-orders");
  const platform: Platform = createPlatform({
    cfg, store,
    mockRecords: { get: async (a) => (await mocks.get(a)) ?? undefined, set: mocks.put, keys: mocks.keys },
    mockSeed: crypto.randomUUID(),
    shopOrders: { get: shop.get, put: (o) => shop.put(o.id, o) },
    ipHeader: "cf-connecting-ip",
    onSettlerEvent: (e) => (e.type === "error" ? console.error("settler", e) : console.log("settler", JSON.stringify(e))),
  });
  cached = { key, platform, store };
  return cached;
}

async function tick(platform: Platform, store: D1Store) {
  if (!(await store.claimOnce("settler:tick", TICK_LEASE_MS, Date.now()))) return;
  await platform.settler.tick();
}

const API = /^\/(v1|relayer|api|health)(\/|$)/;

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!API.test(url.pathname)) {
      const asset = await env.ASSETS.fetch(new Request(new URL(webAssetPath(url.pathname), url), req));
      const res = new Response(asset.body, asset);
      // public/_headers (applied by the assets binding) denies framing everywhere;
      // the checkout shell is the one page that must be framable.
      if (url.pathname.startsWith("/c/")) res.headers.delete("x-frame-options");
      for (const [k, v] of Object.entries(webHeaders(url.pathname))) res.headers.set(k, v);
      return res;
    }
    let p;
    try {
      p = platformFor(env);
    } catch (e) {
      if (e instanceof ConfigError) return Response.json({ error: { message: `server not configured: ${e.message}` } }, { status: 503 });
      throw e;
    }
    const res = await p.platform.app.fetch(req, env);
    if (NUDGE.test(url.pathname)) ctx.waitUntil(tick(p.platform, p.store).catch((e) => console.error("tick", e)));
    return res;
  },

  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const p = platformFor(env);
    ctx.waitUntil(tick(p.platform, p.store));
  },
};
