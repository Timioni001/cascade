"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Printer, ReceiptText } from "lucide-react";
import type { Invoice } from "@cascade/sdk";
import { publicApi, routeId } from "../../../lib/api";
import { Badge, Brand, DemoBanner, Mark, Skeleton, usd } from "../../components/ui";

const long = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/** Hosted invoice: line items, due date, and one button to pay with any coin on any chain. */
export function InvoicePage() {
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = routeId();
    const load = () => publicApi<Invoice>(`/invoices/${id}`).then(setInv, (e: Error) => setError(e.message));
    void load();
    // Coming back from the checkout: refresh until the payment is recorded.
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  async function pay() {
    if (!inv) return;
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await publicApi<{ sessionId: string }>(`/invoices/${inv.id}/pay`, {});
      window.location.href = `/c/${sessionId}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <DemoBanner />
      <main className="container stack-lg" style={{ maxWidth: 760, padding: "32px 16px 64px" }}>
        <div className="row no-print"><Brand /><button className="btn ghost sm" onClick={() => window.print()} disabled={!inv}><Printer size={14} /> Print or save PDF</button></div>
        {error && <div className="card error small">{error}</div>}
        {!inv && !error && (
          <div className="paper stack-lg" style={{ padding: "36px 36px 28px" }} aria-busy="true" aria-label="Loading invoice">
            <div className="row"><Skeleton w="40%" h={22} /><Skeleton w={90} h={22} /></div>
            <div className="grid-3">{[0, 1, 2].map((i) => <Skeleton key={i} h={40} />)}</div>
            {[0, 1, 2].map((i) => <Skeleton key={i} h={22} />)}
            <div className="row"><Skeleton w={120} h={14} /><Skeleton w={140} h={30} /></div>
            <Skeleton h={52} r={12} />
          </div>
        )}
        {inv && (
          <article className="paper rise" style={{ padding: "36px 36px 28px", boxShadow: "var(--shadow)" }}>
            <header className="row" style={{ alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 20, letterSpacing: "-0.02em" }}>{inv.merchant.name}</div>
                <div className="mono tiny muted">{inv.merchant.account}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="small muted">Invoice</div>
                <div style={{ fontWeight: 600 }}>{inv.number}</div>
                <div style={{ marginTop: 6 }}>
                  <Badge tone={inv.status === "paid" ? "ok" : inv.status === "void" ? "neutral" : inv.overdue ? "bad" : "warn"}>{inv.status === "open" ? (inv.overdue ? "overdue" : "due") : inv.status}</Badge>
                </div>
              </div>
            </header>

            <div className="grid-3" style={{ marginTop: 28, gap: 12 }}>
              <div><div className="tiny muted">Billed to</div><div className="small" style={{ fontWeight: 500 }}>{inv.customer.name}</div>{inv.customer.email && <div className="tiny soft">{inv.customer.email}</div>}</div>
              <div><div className="tiny muted">Issued</div><div className="small">{long(inv.createdAt.slice(0, 10))}</div></div>
              <div><div className="tiny muted">Due</div><div className="small">{long(inv.dueDate)}</div></div>
            </div>
            {inv.period && <div className="tiny muted" style={{ marginTop: 12 }}>Service period {inv.period.start.slice(0, 10)} to {inv.period.end.slice(0, 10)}</div>}

            <table className="table" style={{ marginTop: 24 }}>
              <thead><tr><th>Description</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Unit</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>
                {inv.items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.description}</td>
                    <td className="num" style={{ textAlign: "right" }}>{it.quantity}</td>
                    <td className="num" style={{ textAlign: "right" }}>{usd(it.unitAmount)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{usd(BigInt(it.unitAmount) * BigInt(it.quantity))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ borderTop: "1px solid var(--line-strong)", paddingTop: 14, marginTop: 4 }}>
              <span className="small muted">Total due (USD)</span>
              <span className="num" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.03em" }}>${inv.amountFormatted}</span>
            </div>
            {inv.memo && <p className="small soft" style={{ marginTop: 18 }}>{inv.memo}</p>}

            <div className="no-print" style={{ marginTop: 24 }}>
              {inv.status === "open" && (
                <>
                  <button className="btn block" style={{ height: 52 }} onClick={pay} disabled={busy}>
                    {busy ? <Loader2 size={18} className="spin" /> : <Mark size={16} />} Pay ${inv.amountFormatted} with any crypto
                  </button>
                  <div className="tiny muted" style={{ marginTop: 10, textAlign: "center" }}>ETH, SOL, BTC, USDC and 200+ more coins on 35+ chains. No account needed.</div>
                </>
              )}
              {inv.status === "paid" && (
                <div className="row" style={{ background: "var(--ok-soft)", borderRadius: "var(--r-md)", padding: "14px 16px" }}>
                  <span className="row-start" style={{ color: "var(--ok)", fontWeight: 600 }}><Check size={18} /> Paid {inv.paidAt ? new Date(inv.paidAt).toLocaleDateString() : ""}</span>
                  {inv.sessionId && <a className="btn ghost sm" href={`/r/${inv.sessionId}`}><ReceiptText size={14} /> On-chain receipt{inv.receipt ? ` #${inv.receipt.id}` : ""}</a>}
                </div>
              )}
              {inv.status === "void" && <div className="small muted">This invoice was voided and can no longer be paid.</div>}
            </div>
          </article>
        )}
        <p className="tiny muted no-print" style={{ textAlign: "center" }}>Payments settle through NEAR Intents. {inv ? `${inv.merchant.name} receives exactly $${inv.amountFormatted}.` : ""}</p>
      </main>
    </div>
  );
}
