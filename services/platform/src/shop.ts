/**
 * Oakline Ceramics: the demo merchant, written the way a real shop would use
 * @cascade/sdk. It runs beside Cascade only so the demo is one deployment; it
 * talks to Cascade through the public SDK and its secret key like any other
 * merchant, and it trusts the signed webhook, never the browser, to mark an
 * order paid.
 *
 *   POST /api/shop/session    create a checkout session for the mug
 *   GET  /api/shop/order?id=  the order as the shop's server sees it
 *   POST /api/shop/webhook    Cascade -> shop, HMAC-signed
 *   GET  /api/shop/forecast   a paid API for AI agents (x402, $0.10)
 */
import { Hono } from "hono";
import { Cascade } from "@cascade/sdk/server";
import { x402Guard } from "@cascade/sdk/x402";
import { SIGNATURE_HEADER, verifyWebhook } from "@cascade/sdk/webhooks";

export type ShopOrder = { id: string; sessionId: string; status: "awaiting_payment" | "paid"; paidAt?: string; receiptId?: number };

export interface ShopOrders {
  get(id: string): Promise<ShopOrder | null>;
  put(o: ShopOrder): Promise<void>;
}

export class MemoryShopOrders implements ShopOrders {
  private readonly m = new Map<string, ShopOrder>();
  async get(id: string) {
    return this.m.get(id) ?? null;
  }
  async put(o: ShopOrder) {
    this.m.set(o.id, o);
  }
}

export const SHOP = {
  name: "Oakline Ceramics",
  product: { sku: "MUG-STONE", name: "Stoneware mug, 350 ml", price: "25.00" },
} as const;

export interface ShopOptions {
  credentials: { secretKey: string; webhookSecret: string } | null;
  orders: ShopOrders;
  /** Where the shop reaches the Cascade API. */
  apiUrl: string;
  /** How it reaches it (in-process on Cloudflare, where a Worker cannot fetch its own URL). */
  fetch?: typeof fetch;
}

const FORECAST_ASSETS = ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "nep141:base.omft.near"];

/** Same city, same numbers: a stand-in for a real data source. */
function forecast(city: string) {
  let h = 0;
  for (const ch of city.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const skies = ["sun", "cloud", "rain", "wind"];
  return Array.from({ length: 3 }, (_, i) => {
    const high = 12 + ((h >>> (i * 3)) % 18);
    return { day: i + 1, high, low: high - 6 - ((h >>> (i * 5)) % 4), sky: skies[(h >>> (i * 2)) % 4] };
  });
}

export function shopApp(o: ShopOptions) {
  const app = new Hono();
  const creds = o.credentials;
  const cascade = creds ? new Cascade({ apiKey: creds.secretKey, baseUrl: o.apiUrl, ...(o.fetch ? { fetch: o.fetch } : {}) }) : null;
  const guard = cascade
    ? x402Guard(cascade, { price: "0.10", description: "3-day forecast", mimeType: "application/json", assets: FORECAST_ASSETS })
    : null;
  const notConfigured = () => Response.json({ error: "demo shop not configured (see docs/hosting.md)" }, { status: 503 });

  app.post("/session", async () => {
    if (!cascade) return notConfigured();
    const orderId = `order-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const session = await cascade.checkout.create(
      { amount: SHOP.product.price, description: SHOP.product.name, reference: orderId, metadata: { sku: SHOP.product.sku } },
      { idempotencyKey: orderId },
    );
    await o.orders.put({ id: orderId, sessionId: session.id, status: "awaiting_payment" });
    return Response.json({ orderId, sessionUrl: session.url });
  });

  app.get("/order", async (c) => {
    const ord = await o.orders.get(c.req.query("id") ?? "");
    return ord ? Response.json(ord) : Response.json({ error: "no such order" }, { status: 404 });
  });

  app.post("/webhook", async (c) => {
    if (!creds) return notConfigured();
    const raw = await c.req.text();
    let event;
    try {
      event = await verifyWebhook(raw, c.req.header(SIGNATURE_HEADER) ?? null, creds.webhookSecret);
    } catch {
      return new Response("bad signature", { status: 400 });
    }
    if (event.type === "checkout.session.completed") {
      const ord = await o.orders.get(event.data.session.reference ?? "");
      if (ord) {
        await o.orders.put({
          ...ord, status: "paid", paidAt: event.created,
          ...(event.data.session.receipt ? { receiptId: event.data.session.receipt.id } : {}),
        });
      }
    }
    return new Response("ok");
  });

  app.get("/forecast", async (c) => {
    if (!guard) return notConfigured();
    const g = await guard(c.req.raw);
    if (!g.paid) return g.response;
    const city = (c.req.query("city") ?? "Lisbon").slice(0, 40);
    return Response.json({ city, days: forecast(city) }, { headers: g.headers });
  });

  return app;
}
