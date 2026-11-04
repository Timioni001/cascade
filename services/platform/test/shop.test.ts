import { describe, expect, it } from "vitest";
import { signWebhook } from "@cascade/sdk/webhooks";
import { MemoryShopOrders, shopApp } from "../src/shop.js";
import { webAssetPath, webHeaders } from "../src/web.js";

const creds = { secretKey: "sk_test_abc", webhookSecret: "whsec_test" };

function shop() {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const api: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, auth: req.headers.get("authorization"), body: await req.json() });
    return Response.json({ id: "cs_1", url: "https://cascade.example/c/cs_1" }, { status: 201 });
  };
  const orders = new MemoryShopOrders();
  return { app: shopApp({ credentials: creds, orders, apiUrl: "https://cascade.example", fetch: api }), calls, orders };
}

describe("demo shop", () => {
  it("creates a session with its secret key, and only a signed webhook marks the order paid", async () => {
    const s = shop();
    const r = (await (await s.app.request("/session", { method: "POST" })).json()) as { orderId: string; sessionUrl: string };
    expect(r.sessionUrl).toBe("https://cascade.example/c/cs_1");
    expect(s.calls[0]).toMatchObject({ url: "https://cascade.example/v1/checkout/sessions", auth: "Bearer sk_test_abc", body: { amount: "25000000", reference: r.orderId } });

    const event = { id: "evt_1", type: "checkout.session.completed", created: "2026-11-04T10:00:00Z", data: { session: { id: "cs_1", reference: r.orderId, receipt: { id: 7 } } } };
    const raw = JSON.stringify(event);
    const forged = await s.app.request("/webhook", { method: "POST", body: raw, headers: { "cascade-signature": await signWebhook("wrong", raw) } });
    expect(forged.status).toBe(400);
    expect((await s.orders.get(r.orderId))?.status).toBe("awaiting_payment");

    const ok = await s.app.request("/webhook", { method: "POST", body: raw, headers: { "cascade-signature": await signWebhook(creds.webhookSecret, raw) } });
    expect(ok.status).toBe(200);
    expect(await (await s.app.request(`/order?id=${r.orderId}`)).json()).toMatchObject({ status: "paid", receiptId: 7 });
  });

  it("answers 503 when not configured", async () => {
    const app = shopApp({ credentials: null, orders: new MemoryShopOrders(), apiUrl: "https://x" });
    expect((await app.request("/session", { method: "POST" })).status).toBe(503);
    expect((await app.request("/forecast")).status).toBe(503);
  });
});

describe("static site routing", () => {
  it("serves one shell per checkout and receipt", () => {
    expect(webAssetPath("/c/cs_AbC123")).toBe("/c/_");
    expect(webAssetPath("/r/cs_AbC123/")).toBe("/r/_");
    expect(webAssetPath("/c/cs_1/../../etc")).toBe("/c/cs_1/../../etc"); // not a shell; the host resolves it safely
    expect(webAssetPath("/i/in_Abc")).toBe("/i/_");
    expect(webAssetPath("/shop")).toBe("/shop");
  });
  it("only the checkout may be framed", () => {
    expect(webHeaders("/c/cs_1")["x-frame-options"]).toBeUndefined();
    expect(webHeaders("/dashboard")["x-frame-options"]).toBe("DENY");
  });
});
