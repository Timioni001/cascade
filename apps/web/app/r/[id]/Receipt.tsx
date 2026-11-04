"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import type { CheckoutSession } from "@cascade/sdk";
import { nearTxUrl, publicApi, routeId } from "../../../lib/api";
import { Brand, DemoBanner, chainName } from "../../components/ui";

type ReceiptData = {
  session: CheckoutSession;
  contract: string;
  onchain: { id: number; owner: string; amount: string; status: string; metadata_hash: string; settlement: { deposit_address: string; amount_out: string; dest_tx: string; settled_at_ms: number } | null } | null;
  expectedHash: string;
  hashMatches: boolean;
  depositMatches: boolean;
  delivery: { status: string; paidWith: { asset: string; symbol: string; chain: string; amount: string } | null; depositAddress: string; nearTx: string | null; quoteSignature: string | null } | null;
};

function Check4({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="row-start" style={{ alignItems: "flex-start", gap: 12 }}>
      <span data-check={ok ? "ok" : "bad"} style={{ width: 22, height: 22, borderRadius: 999, flex: "none", display: "grid", placeItems: "center", background: ok ? "var(--ok-soft)" : "var(--bad-soft)", color: ok ? "var(--ok)" : "var(--bad)", marginTop: 1 }}>
        {ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
      </span>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>{detail}</div>
      </div>
    </div>
  );
}

const Dashed = () => <div style={{ borderTop: "1.5px dashed var(--line-strong)", margin: "18px 0" }} />;

/** Public receipt: anyone can check that the on-chain record matches this payment. */
export function Receipt() {
  const [r, setR] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    publicApi<ReceiptData>(`/sessions/${routeId()}/receipt`).then(setR, (e: Error) => setError(e.message));
  }, []);

  const s = r?.session;
  const tx = r?.onchain?.settlement?.dest_tx ?? null;
  const txUrl = nearTxUrl(tx);
  const when = r?.onchain?.settlement ? new Date(r.onchain.settlement.settled_at_ms) : null;

  return (
    <div className="page">
      <DemoBanner />
      <main className="narrow stack-lg">
        <div className="row"><Brand /><span className="pill">Receipt</span></div>
        {error && <div className="card error">{error}</div>}
        {!r && !error && <div className="card row-start muted"><Loader2 size={16} className="spin" /> Checking the chain…</div>}
        {r && s && (
          <div className="paper rise" style={{ padding: 28, boxShadow: "var(--shadow)" }}>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Paid to</div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{s.merchant.name}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{s.merchant.account}</div>
            <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.04em", marginTop: 18 }} className="num">${s.amountFormatted}</div>
            <div style={{ color: "var(--ink-2)" }}>{s.description}{s.reference ? ` · ${s.reference}` : ""}</div>
            <Dashed />
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: 13 }}>
              <span style={{ color: "var(--muted)" }}>Receipt</span><span className="num">#{r.onchain?.id} on {r.contract}</span>
              {when && <><span style={{ color: "var(--muted)" }}>Settled</span><span>{when.toLocaleString()}</span></>}
              {r.delivery?.paidWith && <><span style={{ color: "var(--muted)" }}>Paid with</span><span className="num">{Number(r.delivery.paidWith.amount).toPrecision(6).replace(/\.?0+$/, "")} {r.delivery.paidWith.symbol} on {chainName(r.delivery.paidWith.chain)}</span></>}
              <span style={{ color: "var(--muted)" }}>Delivered</span><span>${s.amountFormatted} USDC {s.split ? "to a revenue split" : s.escrowId !== null ? `into escrow #${s.escrowId}` : s.payout ? `on ${chainName(s.payout.chain)} to ${s.payout.address.slice(0, 8)}…${s.payout.address.slice(-4)}` : "to the merchant on NEAR"}</span>
            </div>
            <Dashed />
            <div className="stack" style={{ display: "grid", gap: 14 }}>
              <Check4 ok={r.onchain?.status === "Paid"} title="Recorded as paid on NEAR" detail={`Receipt #${r.onchain?.id} in contract ${r.contract}`} />
              <Check4 ok={r.hashMatches} title="Bound to this exact order" detail={`Hash ${r.expectedHash.slice(0, 16)}…`} />
              <Check4 ok={r.depositMatches} title="Same one-time deposit address" detail={`${r.delivery?.depositAddress.slice(0, 18) ?? ""}…`} />
              <Check4 ok={r.delivery?.status === "SUCCESS"} title="Delivered by NEAR Intents" detail="1Click reports the swap complete" />
            </div>
            <Dashed />
            {tx && (txUrl ? (
              <a href={txUrl} target="_blank" rel="noreferrer" className="row" style={{ fontSize: 13, fontWeight: 600 }}>View delivery transaction <ExternalLink size={14} /></a>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Delivery tx <span className="mono">{tx}</span></div>
            ))}
          </div>
        )}
        <p className="tiny muted" style={{ textAlign: "center" }}>These checks are recomputed from the blockchain and 1Click every time this page loads.</p>
      </main>
    </div>
  );
}
