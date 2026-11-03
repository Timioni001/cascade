"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildEvmTransfer, isEvmChain, payWithEvmWallet, type Eip1193 } from "@cascade/sdk/evm";
import type { CheckoutSession, PayAsset, PaymentPreview } from "@cascade/sdk";
import type { CheckoutMessage } from "@cascade/sdk/browser";

const API = process.env.NEXT_PUBLIC_CASCADE_API ?? "http://127.0.0.1:8788";
const SANDBOX = process.env.NEXT_PUBLIC_SANDBOX === "1";

/** What we show first. Everything else 1Click supports is under "More coins". */
const FEATURED = [
  "nep141:base.omft.near",
  "nep141:eth.omft.near",
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  "nep141:sol.omft.near",
  "nep141:btc.omft.near",
];
const CHAIN_NAMES: Record<string, string> = {
  near: "NEAR", eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon", bsc: "BNB Chain",
  sol: "Solana", btc: "Bitcoin", tron: "Tron", ton: "TON", doge: "Dogecoin", xrp: "XRP", zec: "Zcash", sui: "Sui",
};
const chainName = (c: string) => CHAIN_NAMES[c] ?? c;
/** Display only: at most 8 decimals, trailing zeros trimmed, never rounded down to 0. The wallet always gets the exact amount. */
function short(v: string): string {
  const [w, f = ""] = v.split(".");
  const t = f.slice(0, 8).replace(/0+$/, "");
  return t ? `${w}.${t}` : (w ?? v);
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/v1/public${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

function plain(status: string | undefined, session: CheckoutSession | null): { text: string; tone: "" | "ok" | "bad" } {
  if (session?.status === "paid") return { text: "Paid", tone: "ok" };
  if (session?.status === "expired") return { text: "Expired", tone: "bad" };
  switch (status) {
    case "PENDING_DEPOSIT": return { text: "Waiting for your payment", tone: "" };
    case "KNOWN_DEPOSIT_TX": case "PROCESSING": return { text: "Payment received, converting to USD", tone: "" };
    case "INCOMPLETE_DEPOSIT": return { text: "Less than the full amount arrived", tone: "bad" };
    case "SUCCESS": return { text: "Delivered, confirming receipt", tone: "" };
    case "REFUNDED": return { text: "Refunded to you", tone: "bad" };
    case "FAILED": return { text: "Failed", tone: "bad" };
    default: return { text: "Choose how to pay", tone: "" };
  }
}

export function Checkout({ id, embed, parent }: { id: string; embed: boolean; parent: string | null }) {
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [assets, setAssets] = useState<PayAsset[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [refundTo, setRefundTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const notifiedPaid = useRef(false);
  const rootRef = useRef<HTMLElement>(null);

  const post = useCallback(
    (type: CheckoutMessage["type"], extra: Partial<CheckoutMessage> = {}) => {
      // Only ever talk to the origin that opened us (passed by the SDK as ?parent=).
      if (embed && parent && window.parent !== window) window.parent.postMessage({ source: "cascade-checkout", version: 1, type, sessionId: id, ...extra } satisfies CheckoutMessage, parent);
    },
    [embed, parent, id],
  );

  useEffect(() => {
    api<CheckoutSession>(`/sessions/${id}`).then(setSession, (e: Error) => setError(e.message));
    api<{ data: PayAsset[] }>("/assets").then((r) => setAssets(r.data), () => undefined);
    post("ready");
  }, [id, post]);

  // Poll while money might be moving.
  useEffect(() => {
    if (!session || session.status === "paid" || session.status === "expired" || !session.payment) return;
    const t = setInterval(() => api<CheckoutSession>(`/sessions/${id}`).then(setSession, () => undefined), 2500);
    return () => clearInterval(t);
  }, [id, session]);

  useEffect(() => {
    if (session?.status === "paid" && !notifiedPaid.current) {
      notifiedPaid.current = true;
      post("paid");
    }
  }, [session, post]);

  // Attach once the real page (not the loading placeholder) is rendered.
  const loaded = session !== null;
  useEffect(() => {
    if (!embed || !loaded || !rootRef.current) return;
    const el = rootRef.current;
    const ro = new ResizeObserver(() => post("resize", { height: Math.ceil(el.getBoundingClientRect().height) + 8 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [embed, loaded, post]);

  // Inside the iframe, Escape never reaches the merchant's page: handle it here.
  useEffect(() => {
    if (!embed) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && post("closed");
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [embed, post]);

  const asset = useMemo(() => assets.find((a) => a.assetId === assetId) ?? null, [assets, assetId]);
  const featured = useMemo(() => FEATURED.map((f) => assets.find((a) => a.assetId === f)).filter((a): a is PayAsset => !!a), [assets]);
  const list = showAll ? [...assets].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.chain.localeCompare(b.chain)) : featured;
  const wallet = typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;

  async function choose(a: PayAsset) {
    setAssetId(a.assetId);
    setPreview(null);
    setError(null);
    try {
      setPreview(await api<PaymentPreview>(`/sessions/${id}/preview`, { assetId: a.assetId }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function payWithWallet() {
    if (!asset || !wallet) return;
    setBusy(true);
    setError(null);
    try {
      const [from] = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
      const s = await api<CheckoutSession>(`/sessions/${id}/pay`, { assetId: asset.assetId, refundTo: from });
      setSession(s);
      const tx = buildEvmTransfer({ chain: asset.chain, depositAddress: s.payment!.depositAddress, amount: s.payment!.amountIn, tokenContract: asset.contractAddress });
      const hash = await payWithEvmWallet(wallet, tx);
      setSession(await api<CheckoutSession>(`/sessions/${id}/deposit`, { txHash: hash }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function payManually() {
    if (!asset) return;
    setBusy(true);
    setError(null);
    try {
      setSession(await api<CheckoutSession>(`/sessions/${id}/pay`, { assetId: asset.assetId, refundTo: refundTo.trim() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function simulate() {
    setBusy(true);
    try {
      setSession(await api<CheckoutSession>(`/dev/sessions/${id}/simulate-deposit`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !session) return <main><div className="card error">{error}</div></main>;
  if (!session) return <main><div className="card muted">Loading…</div></main>;

  const st = plain(session.payment?.status, session);
  const paid = session.status === "paid";
  const p = session.payment;
  const evm = asset ? isEvmChain(asset.chain) : false;

  return (
    <main ref={rootRef}>
      <div className="card stack">
        <div className="row">
          <div>
            <div className="muted small">Pay {session.merchant.name}</div>
            <div className="amount">${session.amountFormatted}</div>
            <div className="muted small">{session.description}</div>
          </div>
          {embed && <button className="btn secondary" style={{ width: "auto" }} onClick={() => post("closed")} aria-label="Close">✕</button>}
        </div>
        <hr />

        {paid ? (
          <div className="stack">
            <div className={`status ok`}><span className="dot" />Paid</div>
            <div className="small muted">
              {session.merchant.name} received ${session.amountFormatted} in USDC on NEAR.
              {session.receipt && <> Receipt #{session.receipt.id} is recorded on-chain{session.receipt.nearTx ? <> (tx <span className="mono">{session.receipt.nearTx.slice(0, 10)}…</span>)</> : null}.</>}
            </div>
            {session.successUrl && !embed && <a className="btn" href={session.successUrl} style={{ display: "block", textAlign: "center", textDecoration: "none" }}>Back to {session.merchant.name}</a>}
          </div>
        ) : p ? (
          <div className="stack">
            <div className={`status ${st.tone}`}><span className="dot" />{st.text}</div>
            <div className="small muted">Send exactly</div>
            <div className="row"><strong>{short(p.amountInFormatted)} {assets.find((a) => a.assetId === p.asset)?.symbol ?? ""}</strong><span className="muted small">on {chainName(p.chain)}</span></div>
            <div className="small muted">to this one-time address</div>
            <div className="mono">{p.depositAddress}</div>
            {p.depositMemo && <div className="small">Memo (required): <span className="mono">{p.depositMemo}</span></div>}
            <button className="btn secondary" onClick={() => navigator.clipboard.writeText(p.depositAddress).then(() => setCopied(true))}>{copied ? "Copied" : "Copy address"}</button>
            <div className="small muted">Use this address once, before {new Date(p.deadline).toLocaleTimeString()}. If anything goes wrong your coins are refunded to you automatically.</div>
            {SANDBOX && p.status === "PENDING_DEPOSIT" && <button className="btn" disabled={busy} onClick={simulate}>Simulate the payment (sandbox)</button>}
          </div>
        ) : (
          <div className="stack">
            <div className="small muted">Pay with</div>
            <div className="assets">
              {list.map((a) => (
                <button key={a.assetId} className="asset" aria-pressed={a.assetId === assetId} onClick={() => choose(a)}>
                  <div><strong>{a.symbol}</strong></div>
                  <div className="small muted">{chainName(a.chain)}</div>
                </button>
              ))}
            </div>
            {!showAll && assets.length > featured.length && <button className="btn secondary" onClick={() => setShowAll(true)}>More coins ({assets.length})</button>}
            {asset && (
              <div className="stack">
                {preview ? (
                  <div className="row"><span>You pay</span><strong>{short(preview.amountInFormatted)} {asset.symbol} <span className="muted small">≈ ${Number(preview.amountInUsd).toFixed(2)}</span></strong></div>
                ) : (
                  <div className="muted small">Getting a price…</div>
                )}
                {evm && wallet ? (
                  <button className="btn" disabled={!preview || busy} onClick={payWithWallet}>{busy ? "Confirm in your wallet…" : `Pay with wallet`}</button>
                ) : (
                  <>
                    <input placeholder={`Your ${chainName(asset.chain)} address (for refunds)`} value={refundTo} onChange={(e) => setRefundTo(e.target.value)} />
                    <button className="btn" disabled={!preview || busy || refundTo.trim().length < 10} onClick={payManually}>Get payment address</button>
                  </>
                )}
                {evm && !wallet && <div className="small muted">No browser wallet found: you can still pay by sending to an address.</div>}
              </div>
            )}
          </div>
        )}
        {error && <div className="error small">{error}</div>}
        <div className="small muted" style={{ textAlign: "center" }}>Settles in USDC on NEAR through NEAR Intents</div>
      </div>
    </main>
  );
}
