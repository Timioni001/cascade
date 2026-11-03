/**
 * The demo shop's own backend state. A real shop would use its database; the
 * point here is that fulfilment is driven by the verified webhook, not by the
 * browser saying "paid".
 */
type Order = { id: string; sessionId: string; status: "awaiting_payment" | "paid"; paidAt?: string; receiptId?: number };
const g = globalThis as unknown as { __shopOrders?: Map<string, Order> };
export const orders: Map<string, Order> = (g.__shopOrders ??= new Map());
export const SHOP_API = process.env.CASCADE_API_URL ?? "http://127.0.0.1:8788";
export const SHOP_KEY = process.env.CASCADE_SECRET_KEY ?? "";
export const SHOP_WEBHOOK_SECRET = process.env.CASCADE_WEBHOOK_SECRET ?? "";
