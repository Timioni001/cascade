"use client";

import { useEffect, useState } from "react";
import { Bot, Check, Loader2, Package, Truck } from "lucide-react";
import { openCheckout } from "@cascade/sdk/browser";
import { DemoBanner, Mark } from "../components/ui";

type Order = { id: string; status: string; receiptId?: number };

/** The product shot: a stoneware mug, drawn (no stock photo). */
function Mug() {
  return (
    <svg viewBox="0 0 400 400" width="100%" height="100%" role="img" aria-label="Stoneware mug in a matte oat glaze">
      <defs>
        <linearGradient id="body" x1="0" x2="1">
          <stop offset="0" stopColor="#d9d3c8" />
          <stop offset="0.55" stopColor="#ece8e1" />
          <stop offset="1" stopColor="#c9c2b6" />
        </linearGradient>
        <linearGradient id="dip" x1="0" x2="1">
          <stop offset="0" stopColor="#56524c" />
          <stop offset="0.55" stopColor="#6d6862" />
          <stop offset="1" stopColor="#4a4641" />
        </linearGradient>
        <radialGradient id="shadow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#000" stopOpacity="0.18" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="190" cy="318" rx="120" ry="16" fill="url(#shadow)" />
      <path d="M262 168c40-4 58 20 54 46-4 30-30 46-60 44" fill="none" stroke="#cfc8bc" strokeWidth="18" strokeLinecap="round" />
      <path d="M100 120h180v160c0 22-18 38-40 38h-100c-22 0-40-16-40-38z" fill="url(#body)" />
      <path d="M100 230c30 8 60-6 90 2s60 6 90-4v52c0 22-18 38-40 38h-100c-22 0-40-16-40-38z" fill="url(#dip)" />
      <ellipse cx="190" cy="120" rx="90" ry="14" fill="#c4bdb1" />
      <ellipse cx="190" cy="121" rx="80" ry="10" fill="#8f877c" />
      <path d="M120 140v120" stroke="#fff" strokeOpacity="0.35" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}

/** Oakline Ceramics: a demo merchant using @cascade/sdk the way a real shop would. */
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
    <div className="page">
      <DemoBanner />
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
        <div className="container row" style={{ height: 60 }}>
          <span style={{ fontWeight: 600, letterSpacing: "-0.02em", fontSize: 17 }}>Oakline Ceramics</span>
          <span className="small muted">Demo store · checkout by Cascade</span>
        </div>
      </header>

      <main className="container" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,0.9fr)", gap: 48, padding: "48px 24px 64px", alignItems: "start" }}>
        <div style={{ aspectRatio: "1", borderRadius: "var(--r-xl)", overflow: "hidden", background: "#e9e6e0", border: "1px solid var(--line)", display: "grid", placeItems: "center", padding: "8%" }}>
          <Mug />
        </div>

        <div className="stack-lg" style={{ position: "sticky", top: 32 }}>
          <div className="small muted">Stoneware · 350 ml · dishwasher safe</div>
          <h1 className="h1">Stoneware mug</h1>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.03em" }} className="num">$25.00</div>
          <p className="soft" style={{ margin: 0 }}>Wheel-thrown, with a matte oat glaze and a charcoal dip. Each one is a little different.</p>

          {paid ? (
            <div className="card tight rise">
              <div className="row-start" style={{ gap: 12 }}>
                <span style={{ width: 34, height: 34, borderRadius: 999, background: "var(--ok-soft)", color: "var(--ok)", display: "grid", placeItems: "center" }}><Check size={17} strokeWidth={2.5} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>Order {order!.id} is paid</div>
                  <div className="small muted">Confirmed by a signed webhook{order!.receiptId !== undefined ? ` · receipt #${order!.receiptId}` : ""}</div>
                </div>
              </div>
              <div className="row-start small soft" style={{ gap: 8, marginTop: 14 }}><Truck size={15} /> Ships within 2 days</div>
            </div>
          ) : (
            <button className="btn block" style={{ height: 52 }} onClick={buy} disabled={busy}>
              {busy ? <Loader2 size={18} className="spin" /> : <Mark size={16} />} Pay with any crypto
            </button>
          )}
          {order && !paid && <div className="row-start small muted" style={{ gap: 8 }}><Loader2 size={14} className="spin" /> Order {order.id}: waiting for payment</div>}
          {error && <div className="error small">{error}</div>}

          <div className="small soft" style={{ display: "grid", gap: 10, borderTop: "1px solid var(--line)", paddingTop: 18 }}>
            <span className="row-start" style={{ gap: 8 }}><Package size={15} /> Pay with any coin on any chain; the shop receives dollars</span>
            <span className="row-start" style={{ gap: 8 }}><Bot size={15} /> For agents: <code className="mono">GET /api/shop/forecast</code> costs $0.10 per call (x402)</span>
          </div>
        </div>
      </main>
    </div>
  );
}
