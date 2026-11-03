"use client";

import { use, useEffect, useState } from "react";
import type { CheckoutSession } from "@cascade/sdk";
import { nearTxUrl, publicApi } from "../../../lib/api";

type Receipt = {
  session: CheckoutSession;
  contract: string;
  onchain: { id: number; owner: string; amount: string; status: string; metadata_hash: string; settlement: { deposit_address: string; amount_out: string; dest_tx: string } | null } | null;
  expectedHash: string;
  hashMatches: boolean;
  depositMatches: boolean;
  delivery: { status: string; paidWith: { asset: string; symbol: string; chain: string; amount: string } | null; depositAddress: string; nearTx: string | null; quoteSignature: string | null } | null;
};

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: "flex-start" }}>
      <span className={`status ${ok ? "ok" : "bad"}`}><span className="dot" /></span>
      <span>{children}</span>
    </div>
  );
}

/** Public receipt: anyone can check that the on-chain record matches this payment. */
export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    publicApi<Receipt>(`/sessions/${id}/receipt`).then(setR, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <main><div className="card error">{error}</div></main>;
  if (!r) return <main><div className="card muted">Loading…</div></main>;
  const s = r.session;
  const tx = r.onchain?.settlement?.dest_tx ?? null;
  const txUrl = nearTxUrl(tx);
  return (
    <main className="stack">
      <div className="small muted">Receipt</div>
      <div className="card stack">
        <div>
          <div className="muted small">{s.merchant.name} · {s.merchant.account}</div>
          <div className="amount">${s.amountFormatted}</div>
          <div className="muted small">{s.description}{s.reference ? ` · ${s.reference}` : ""}</div>
        </div>
        <hr />
        <Check ok={r.onchain?.status === "Paid"}>Recorded as paid on NEAR (receipt #{r.onchain?.id}, contract <span className="mono">{r.contract}</span>)</Check>
        <Check ok={r.hashMatches}>The on-chain record is bound to this exact order (hash <span className="mono">{r.expectedHash.slice(0, 12)}…</span>)</Check>
        <Check ok={r.depositMatches}>It names the same one-time deposit address the customer paid</Check>
        <Check ok={r.delivery?.status === "SUCCESS"}>NEAR Intents reports the payment delivered</Check>
        {r.delivery?.paidWith && <div className="small muted">Paid with {Number(r.delivery.paidWith.amount).toPrecision(6).replace(/\.?0+$/, "")} {r.delivery.paidWith.symbol} on {r.delivery.paidWith.chain}. Delivered ${s.amountFormatted} in USDC to {s.split ? "a revenue split" : s.merchant.account}.</div>}
        {tx && (txUrl ? <a className="small" href={txUrl} target="_blank" rel="noreferrer">View the delivery transaction ↗</a> : <div className="small muted">Delivery tx <span className="mono">{tx}</span></div>)}
      </div>
      <div className="small muted">These checks are recomputed from the blockchain and 1Click each time this page loads.</div>
    </main>
  );
}
