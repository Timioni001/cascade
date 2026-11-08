"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Delete, ExternalLink, Loader2, Store } from "lucide-react";
import type { CheckoutSession } from "@cascade/sdk";
import { call } from "../dashboard/api";
import { readKey, saveKey } from "../../lib/session";
import { PaymentQr } from "../components/PaymentQr";
import { Brand, DemoBanner } from "../components/ui";


/** cents string -> "$12.34" */
const fmt = (cents: string) => `$${(Number(cents || "0") / 100).toFixed(2)}`;

/**
 * Point of sale: type an amount, the customer scans the QR with any wallet
 * and pays in any coin, the screen turns green when the money has arrived.
 */
export default function Pos() {
  const [key, setKey] = useState("");
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [cents, setCents] = useState("");
  const [note, setNote] = useState("");
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merchant, setMerchant] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setKey(readKey());
    setReady(true);
  }, []);
  useEffect(() => {
    if (key) call<{ name: string }>(key, "merchant").then((m) => setMerchant(m.name), (e: Error) => setError(e.message));
  }, [key]);

  const press = (d: string) => setCents((c) => (d === "back" ? c.slice(0, -1) : (c + d).replace(/^0+/, "").slice(0, 8)));

  const charge = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await call<CheckoutSession>(key, "checkout/sessions", { amount: String(Number(cents) * 10_000), description: note.trim() || "In-store purchase", expiresInMinutes: 30, metadata: { channel: "pos" } });
      setSession(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const poll = useCallback(() => {
    if (!session) return;
    call<CheckoutSession>(key, `checkout/sessions/${session.id}`).then(setSession, () => undefined);
  }, [key, session]);
  useEffect(() => {
    if (!session || session.status === "paid" || session.status === "expired") return;
    timer.current = setInterval(poll, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [session, poll]);

  const reset = () => {
    setSession(null);
    setCents("");
    setNote("");
  };

  if (!ready) return <div className="page" />;

  if (!key) {
    return (
      <div className="page">
        <DemoBanner />
        <main className="narrow stack-lg" style={{ paddingTop: 64 }}>
          <Brand />
          <div className="card stack-lg">
            <div><h1 className="h1">Point of sale</h1><p className="small soft" style={{ margin: "8px 0 0" }}>Take in-person payments in any coin. Sign in with your secret key, or create a sandbox account first.</p></div>
            <input className="input" type="password" placeholder="sk_…" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Secret key" />
            <button className="btn block" disabled={!input.startsWith("sk_")} onClick={() => { const k = input.trim(); saveKey(k, true); setKey(k); }}>Open register</button>
            <a className="btn ghost block" href="/start">Create a sandbox account</a>
          </div>
        </main>
      </div>
    );
  }

  const url = session ? session.url.replace(/^https?:\/\/[^/]+/, window.location.origin) : "";
  return (
    <div className="page">
      <DemoBanner />
      <main className="narrow stack-lg" style={{ paddingTop: 24, maxWidth: 420 }}>
        <div className="row"><span className="row-start" style={{ fontWeight: 600 }}><Store size={18} /> {merchant ?? "…"}</span><a className="btn ghost sm" href="/dashboard">Dashboard</a></div>

        {!session && (
          <div className="card stack-lg">
            <div style={{ textAlign: "center" }}>
              <div className="tiny muted">Amount</div>
              <div className="num" style={{ fontSize: 56, fontWeight: 600, letterSpacing: "-0.04em" }} aria-live="polite">{fmt(cents)}</div>
            </div>
            <input className="input" placeholder="What is it for? (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} aria-label="Description" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"].map((d) => (
                <button key={d} className="btn ghost" style={{ height: 60, fontSize: 22 }} onClick={() => press(d)} aria-label={d === "back" ? "Delete" : d}>
                  {d === "back" ? <Delete size={20} /> : d}
                </button>
              ))}
            </div>
            <button className="btn block" style={{ height: 56, fontSize: 17 }} disabled={busy || Number(cents) < 50} onClick={charge}>
              {busy ? <Loader2 size={18} className="spin" /> : `Charge ${fmt(cents)}`}
            </button>
            {error && <div className="small error">{error}</div>}
          </div>
        )}

        {session && session.status !== "paid" && (
          <div className="card stack-lg" style={{ textAlign: "center" }}>
            <div className="tiny muted">Scan to pay with any coin</div>
            <div className="num" style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.04em" }}>${session.amountFormatted}</div>
            <div className="paper" style={{ padding: 16, display: "grid", placeItems: "center" }}><PaymentQr uri={url} label={`Pay $${session.amountFormatted}`} size={240} /></div>
            <div className="row-start small muted" style={{ justifyContent: "center" }}><Loader2 size={14} className="spin" /> Waiting for payment… ETH, SOL, BTC, USDC and 200+ coins</div>
            <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open the checkout on this device</a>
            <button className="btn ghost sm" onClick={reset}><ArrowLeft size={14} /> Cancel</button>
          </div>
        )}

        {session?.status === "paid" && (
          <div className="card stack-lg rise" style={{ textAlign: "center" }}>
            <span style={{ width: 72, height: 72, borderRadius: 999, background: "var(--ok-soft)", color: "var(--ok)", display: "grid", placeItems: "center", margin: "0 auto" }}><Check size={36} /></span>
            <div className="num" style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.04em" }}>${session.amountFormatted}</div>
            <div className="soft">Paid. The money is in your account as USDC.</div>
            <a className="btn ghost" href={`/r/${session.id}`} target="_blank" rel="noreferrer">On-chain receipt</a>
            <button className="btn block" onClick={reset}>New sale</button>
          </div>
        )}
      </main>
    </div>
  );
}
