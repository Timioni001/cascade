import { Cascade } from "@cascade/sdk/server";
import { orders, SHOP_API, SHOP_KEY } from "../../../../lib/shop";

/** The shop's server creates a checkout session (secret key stays on the server). */
export async function POST() {
  if (!SHOP_KEY) return Response.json({ error: "demo shop not configured: run pnpm dev" }, { status: 503 });
  const cascade = new Cascade({ apiKey: SHOP_KEY, baseUrl: SHOP_API });
  const orderId = `order-${Date.now().toString(36)}`;
  const session = await cascade.checkout.create(
    { amount: "25.00", description: "A2 poster, 'Lagos at dusk'", reference: orderId, metadata: { sku: "A2-DUSK" } },
    { idempotencyKey: orderId },
  );
  orders.set(orderId, { id: orderId, sessionId: session.id, status: "awaiting_payment" });
  return Response.json({ orderId, sessionUrl: session.url });
}
