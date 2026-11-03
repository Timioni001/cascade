"use client";

import { useEffect, useState } from "react";
import { Bot, Check, Loader2, Package, Truck } from "lucide-react";
import { openCheckout } from "@cascade/sdk/browser";
import { DemoBanner, Mark } from "../components/ui";

type Order = { id: string; status: string; receiptId?: number };

/** Lagos Prints: a demo merchant using @cascade/sdk the way a real shop would. */
export default function Shop() {
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The shop trusts its own server (updated by the verified webhook), not the browser.
  useEffect(() => {
    if (!order || order.status === "paid") return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/shop/order?id=${order.id}`);
      if (r.ok) setOrder(await r.json());
    }, 1500);
    return () => clearInterval(t);
  }, [order]);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/shop/session", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setOrder({ id: j.orderId, status: "awaiting_payment" });
      openCheckout({ sessionUrl: j.sessionUrl });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const paid = order?.status === "paid";

  return (
    <div className="page" style={{ background: "#f4f3ee", color: "#151515", colorScheme: "light" }}>
      <DemoBanner />
      <header style={{ borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
        <div className="container row" style={{ height: 64 }}>
          <span style={{ fontWeight: 700, letterSpacing: "-0.03em", fontSize: 18 }}>Lagos Prints</span>
          <span style={{ fontSize: 13, color: "#66665f" }}>Demo store · pays out through Cascade</span>
        </div>
      </header>

      <main className="container" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.15fr) minmax(0,0.85fr)", gap: 40, padding: "48px 24px 64px", alignItems: "start" }}>
        <div style={{ aspectRatio: "4 / 5", borderRadius: 28, overflow: "hidden", position: "relative", background: "linear-gradient(170deg,#f8b26a 0%,#e9707a 38%,#8e3b6e 66%,#1d1838 100%)", boxShadow: "0 30px 80px rgba(60,20,40,0.25)" }}>
          <div style={{ position: "absolute", left: "50%", top: "40%", width: "34%", aspectRatio: "1", borderRadius: "50%", transform: "translate(-50%,-50%)", background: "radial-gradient(circle,#ffe7a8 0%,#ffbf6b 60%,transparent 70%)" }} />
          <div style={{ position: "absolute", inset: "auto 0 0 0", height: "38%", background: "linear-gradient(180deg,transparent,#120f22 60%)" }} />
          <div style={{ position: "absolute", left: 28, bottom: 24, color: "#f4f3ee", fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase" }}>Lagos at dusk · A2</div>
        </div>

        <div className="stack-lg" style={{ position: "sticky", top: 32 }}>
          <div style={{ fontSize: 13, color: "#66665f" }}>Giclée print · 420 × 594 mm</div>
          <h1 className="h1" style={{ color: "#151515" }}>Lagos at dusk</h1>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.03em" }} className="num">$25.00</div>
          <p style={{ color: "#44443f", margin: 0 }}>Third Mainland Bridge at the last minute of light. Archival ink on 310 gsm cotton rag, signed and numbered.</p>

          {paid ? (
            <div className="rise" style={{ background: "#fff", borderRadius: 20, padding: 20, border: "1px solid rgba(0,0,0,0.06)" }}>
              <div className="row-start" style={{ gap: 12 }}>
                <span style={{ width: 36, height: 36, borderRadius: 999, background: "#151515", color: "#d8f45c", display: "grid", placeItems: "center" }}><Check size={18} strokeWidth={3} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>Order {order!.id} is paid</div>
                  <div style={{ fontSize: 13, color: "#66665f" }}>Confirmed by a signed webhook{order!.receiptId !== undefined ? ` · receipt #${order!.receiptId}` : ""}</div>
                </div>
              </div>
              <div className="row-start" style={{ gap: 8, fontSize: 13, color: "#44443f", marginTop: 14 }}><Truck size={15} /> Ships within 2 days</div>
            </div>
          ) : (
            <button className="btn block" style={{ background: "#151515", color: "#f4f3ee", height: 56 }} onClick={buy} disabled={busy}>
              {busy ? <Loader2 size={18} className="spin" /> : <Mark size={16} />} Pay with any crypto
            </button>
          )}
          {order && !paid && <div className="row-start" style={{ fontSize: 13, color: "#66665f", gap: 8 }}><Loader2 size={14} className="spin" /> Order {order.id}: waiting for payment</div>}
          {error && <div className="error small">{error}</div>}

          <div style={{ display: "grid", gap: 10, fontSize: 13, color: "#44443f", borderTop: "1px solid rgba(0,0,0,0.08)", paddingTop: 18 }}>
            <span className="row-start" style={{ gap: 8 }}><Package size={15} /> Any coin on any chain; we receive dollars</span>
            <span className="row-start" style={{ gap: 8 }}><Bot size={15} /> Agents: <code className="mono">GET /api/shop/forecast</code> is paid per call (x402)</span>
          </div>
        </div>
      </main>
    </div>
  );
}
