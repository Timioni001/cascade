"use client";

import { use, useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import type { CheckoutSession } from "@cascade/sdk";
import { nearTxUrl, publicApi } from "../../../lib/api";
import { Brand, DemoBanner, chainName } from "../../components/ui";

type Receipt = {
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
      <span style={{ width: 22, height: 22, borderRadius: 999, flex: "none", display: "grid", placeItems: "center", background: ok ? "#1f7a4a" : "#b42318", color: "#fff", marginTop: 1 }}>
        {ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
      </span>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 12, color: "#66665f" }}>{detail}</div>
      </div>
    </div>
  );
}

const Dashed = () => <div style={{ borderTop: "1.5px dashed #d6d4ca", margin: "18px 0" }} />;

/** Public receipt: anyone can check that the on-chain record matches this payment. */
export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    publicApi<Receipt>(`/sessions/${id}/receipt`).then(setR, (e: Error) => setError(e.message));
  }, [id]);

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
            <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#66665f" }}>Paid to</div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{s.merchant.name}</div>
            <div className="mono" style={{ fontSize: 12, color: "#66665f" }}>{s.merchant.account}</div>
            <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.04em", marginTop: 18 }} className="num">${s.amountFormatted}</div>
            <div style={{ color: "#44443f" }}>{s.description}{s.reference ? ` · ${s.reference}` : ""}</div>
            <Dashed />
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: 13 }}>
              <span style={{ color: "#66665f" }}>Receipt</span><span className="num">#{r.onchain?.id} on {r.contract}</span>
              {when && <><span style={{ color: "#66665f" }}>Settled</span><span>{when.toLocaleString()}</span></>}
              {r.delivery?.paidWith && <><span style={{ color: "#66665f" }}>Paid with</span><span className="num">{Number(r.delivery.paidWith.amount).toPrecision(6).replace(/\.?0+$/, "")} {r.delivery.paidWith.symbol} on {chainName(r.delivery.paidWith.chain)}</span></>}
              <span style={{ color: "#66665f" }}>Delivered</span><span>${s.amountFormatted} USDC to {s.split ? "a revenue split" : "the merchant"}</span>
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
              <div style={{ fontSize: 12, color: "#66665f" }}>Delivery tx <span className="mono">{tx}</span></div>
            ))}
          </div>
        )}
        <p className="tiny muted" style={{ textAlign: "center" }}>These checks are recomputed from the blockchain and 1Click every time this page loads.</p>
      </main>
    </div>
  );
}
