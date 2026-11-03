"use client";

import { useEffect, useState } from "react";
import { openCheckout } from "@cascade/sdk/browser";

type Order = { id: string; status: string; receiptId?: number };

export default function Shop() {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The shop trusts its own server (fed by the verified webhook), not the browser.
  useEffect(() => {
    if (!order || order.status === "paid") return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/shop/order?id=${order.id}`);
      if (r.ok) setOrder(await r.json());
    }, 1500);
    return () => clearInterval(t);
  }, [order]);

  async function buy() {
    setError(null);
    const r = await fetch("/api/shop/session", { method: "POST" });
    const j = await r.json();
    if (!r.ok) return setError(j.error);
    setOrder({ id: j.orderId, status: "awaiting_payment" });
    openCheckout({ sessionUrl: j.sessionUrl });
  }

  return (
    <main className="stack">
      <div className="small muted">Lagos Prints · demo shop</div>
      <div className="card stack">
        <div style={{ aspectRatio: "4 / 3", borderRadius: 10, background: "linear-gradient(160deg,#f6a35c,#c2416b 55%,#2b1d4a)" }} />
        <div className="row"><strong>A2 poster, “Lagos at dusk”</strong><strong>$25.00</strong></div>
        {order?.status === "paid" ? (
          <div className="status ok"><span className="dot" />Order {order.id} paid. Shipping soon.{order.receiptId !== undefined ? ` (receipt #${order.receiptId})` : ""}</div>
        ) : (
          <button className="btn" onClick={buy}>Pay with any crypto</button>
        )}
        {order && order.status !== "paid" && <div className="small muted">Order {order.id}: waiting for payment…</div>}
        {error && <div className="error small">{error}</div>}
      </div>
      <div className="small muted">The button is <code>@cascade/sdk</code>&apos;s <code>openCheckout</code>. The order flips to paid only when the shop&apos;s server receives a signed webhook.</div>
    </main>
  );
}
