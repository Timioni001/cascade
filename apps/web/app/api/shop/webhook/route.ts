import { verifyWebhook, SIGNATURE_HEADER } from "@cascade/sdk/webhooks";
import { orders, SHOP_WEBHOOK_SECRET } from "../../../../lib/shop";

/** Cascade calls this when a session is paid. The signature is checked before anything is trusted. */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const event = await verifyWebhook(raw, req.headers.get(SIGNATURE_HEADER), SHOP_WEBHOOK_SECRET);
    if (event.type === "checkout.session.completed") {
      const ref = event.data.session.reference ?? "";
      const o = orders.get(ref);
      if (o) orders.set(ref, { ...o, status: "paid", paidAt: event.created, ...(event.data.session.receipt ? { receiptId: event.data.session.receipt.id } : {}) });
    }
    return new Response("ok");
  } catch {
    return new Response("bad signature", { status: 400 });
  }
}
