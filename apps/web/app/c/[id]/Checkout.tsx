"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, Loader2, ShieldCheck, Wallet, X } from "lucide-react";
import { buildEvmTransfer, isEvmChain, payWithEvmWallet, type Eip1193 } from "@cascade/sdk/evm";
import type { CheckoutSession, PayAsset, PaymentPreview } from "@cascade/sdk";
import type { CheckoutMessage } from "@cascade/sdk/browser";
import { paymentUri } from "@cascade/sdk/uris";
import { PaymentQr } from "../../components/PaymentQr";
import { CoinMark, DemoBanner, Mark, SANDBOX, Skeleton, chainName, short } from "../../components/ui";
import { publicApi as api } from "../../../lib/api";

/** Shown first; everything else 1Click supports is under "More coins". */
const FEATURED = [
  "nep141:base.omft.near",
  "nep141:eth.omft.near",
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  "nep141:sol.omft.near",
  "nep141:btc.omft.near",
];

type Step = 0 | 1 | 2 | 3;

function statusText(status: string | undefined): string {
  switch (status) {
    case "PENDING_DEPOSIT": return "Waiting for your payment";
    case "KNOWN_DEPOSIT_TX": case "PROCESSING": return "Payment received, converting to dollars";
    case "INCOMPLETE_DEPOSIT": return "Less than the full amount arrived";
    case "SUCCESS": return "Delivered, confirming receipt";
    case "REFUNDED": return "Refunded to you";
    case "FAILED": return "Failed";
    default: return "Waiting for your payment";
  }
}

function Steps({ step }: { step: Step }) {
  const labels = ["Coin", "Send", "Done"];
  return (
    <ol className="row-start" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }} aria-label="Progress">
      {labels.map((l, i) => (
        <li key={l} className="row-start tiny" style={{ gap: 6, color: i <= step ? "var(--ink)" : "var(--muted)" }} aria-current={i === step ? "step" : undefined}>
          <span style={{ width: 18, height: 18, borderRadius: 999, display: "inline-grid", placeItems: "center", fontSize: 10, fontWeight: 700, background: i < step ? "var(--accent)" : i === step ? "var(--ink)" : "var(--card-2)", color: i <= step ? "var(--bg)" : "var(--muted)" }}>
            {i < step ? <Check size={11} strokeWidth={3} /> : i + 1}
          </span>
          {l}
          {i < 2 && <span style={{ width: 18, height: 1, background: "var(--line-strong)", marginLeft: 2 }} />}
        </li>
      ))}
    </ol>
  );
}

function useCountdown(deadline: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  if (!deadline) return null;
  const ms = Math.max(0, Date.parse(deadline) - now);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
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
  const countdown = useCountdown(session?.payment?.deadline);

  async function run(f: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

  const payWithWallet = () =>
    run(async () => {
      if (!asset || !wallet) return;
      const [from] = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
      const s = await api<CheckoutSession>(`/sessions/${id}/pay`, { assetId: asset.assetId, refundTo: from });
      setSession(s);
      const tx = buildEvmTransfer({ chain: asset.chain, depositAddress: s.payment!.depositAddress, amount: s.payment!.amountIn, tokenContract: asset.contractAddress });
      const hash = await payWithEvmWallet(wallet, tx);
      setSession(await api<CheckoutSession>(`/sessions/${id}/deposit`, { txHash: hash }));
    });

  const payManually = () => run(async () => setSession(await api<CheckoutSession>(`/sessions/${id}/pay`, { assetId: asset!.assetId, refundTo: refundTo.trim() })));
  const simulate = () => run(async () => setSession(await api<CheckoutSession>(`/dev/sessions/${id}/simulate-deposit`, {})));

  if (error && !session) return <main className="narrow"><div className="card error">{error}</div></main>;
  if (!session) return <CheckoutSkeleton />;

  const paid = session.status === "paid";
  const p = session.payment;
  const step: Step = paid ? 3 : p ? 1 : 0;
  const evm = asset ? isEvmChain(asset.chain) : false;
  const payAsset = p ? assets.find((x) => x.assetId === p.asset) : null;
  const uri = p && payAsset ? paymentUri({ chain: p.chain, depositAddress: p.depositAddress, amount: p.amountIn, decimals: payAsset.decimals, tokenContract: payAsset.contractAddress, label: session.merchant.name, message: session.description, memo: p.depositMemo }) : null;

  return (
    <>
      <DemoBanner />
      <main ref={rootRef} className="narrow" style={embed ? { padding: 8 } : undefined}>
        <div className="card raised stack-lg rise">
          <div className="row">
            <div className="row-start">
              <span className="brand-mark" style={{ width: 36, height: 36, borderRadius: 12, fontWeight: 700 }}>{session.merchant.name.slice(0, 1)}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{session.merchant.name}</div>
                <div className="tiny muted">{session.merchant.account}</div>
              </div>
            </div>
            {embed && <button className="icon-btn" onClick={() => post("closed")} aria-label="Close checkout"><X size={16} /></button>}
          </div>

          <div>
            <div className="amount">${session.amountFormatted}</div>
            <div className="soft small" style={{ marginTop: 6 }}>{session.description}</div>
          </div>

          <div><Steps step={step} /></div>

          {paid ? (
            <div className="stack-lg rise" style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ width: 64, height: 64, borderRadius: 999, background: "var(--accent)", color: "var(--accent-ink)", display: "grid", placeItems: "center", margin: "0 auto" }}>
                <Check size={30} strokeWidth={3} />
              </div>
              <div>
                <div className="h2">Payment complete</div>
                <p className="soft small" style={{ margin: "6px 0 0" }}>{session.merchant.name} received ${session.amountFormatted} in dollars (USDC on NEAR).</p>
              </div>
              {session.receipt && (
                <a className="btn ghost block" href={`/r/${session.id}`} target="_blank" rel="noreferrer">
                  Verify receipt #{session.receipt.id} <ExternalLink size={14} />
                </a>
              )}
              {session.successUrl && !embed && <a className="btn block" href={session.successUrl}>Back to {session.merchant.name}</a>}
            </div>
          ) : p ? (
            <div className="stack-lg rise">
              <div className="well row">
                <div className="row-start">
                  {payAsset && <CoinMark symbol={payAsset.symbol} chain={payAsset.chain} />}
                  <div>
                    <div className="tiny muted">Send exactly</div>
                    <div style={{ fontWeight: 600, fontSize: 18 }} className="num">{short(p.amountInFormatted)} {payAsset?.symbol}</div>
                  </div>
                </div>
                <span className="pill">{chainName(p.chain)}</span>
              </div>

              {uri && (
                <div style={{ display: "grid", placeItems: "center" }}>
                  <div className="paper" style={{ padding: 10 }}><PaymentQr uri={uri} label={`${short(p.amountInFormatted)} ${payAsset?.symbol} on ${chainName(p.chain)}`} /></div>
                </div>
              )}

              <div className="stack">
                <div className="tiny muted">To this one-time address{countdown ? ` · expires in ${countdown}` : ""}</div>
                <div className="well row" style={{ padding: "10px 10px 10px 16px" }}>
                  <span className="mono" style={{ fontSize: 12 }}>{p.depositAddress}</span>
                  <button className="icon-btn" aria-label="Copy address" onClick={() => navigator.clipboard.writeText(p.depositAddress).then(() => setCopied(true))}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                </div>
                {p.depositMemo && <div className="small">Memo (required): <span className="mono">{p.depositMemo}</span></div>}
              </div>

              <div className="row-start small soft">
                {p.status === "REFUNDED" || p.status === "FAILED" ? <span className="badge bad">{statusText(p.status)}</span> : <><Loader2 size={15} className="spin" /> {statusText(p.status)}</>}
              </div>
              {SANDBOX && p.status === "PENDING_DEPOSIT" && <button className="btn block" disabled={busy} onClick={simulate}>Simulate the payment (sandbox)</button>}
              <p className="tiny muted" style={{ margin: 0 }}>Send once, before it expires. If anything goes wrong, your coins are refunded to you automatically.</p>
            </div>
          ) : (
            <div className="stack-lg">
              <div className="tiny muted">Pay with</div>
              <div className="grid-2 keep-2">
                {list.map((a) => {
                  const on = a.assetId === assetId;
                  return (
                    <button key={a.assetId} onClick={() => choose(a)} aria-pressed={on} className="row-start"
                      style={{ padding: 12, borderRadius: "var(--r-md)", background: on ? "var(--accent-soft)" : "var(--card-2)", border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`, cursor: "pointer", textAlign: "left" }}>
                      <CoinMark symbol={a.symbol} chain={a.chain} size={32} />
                      <span>
                        <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{a.symbol}</span>
                        <span className="tiny muted">{chainName(a.chain)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {!showAll && assets.length > featured.length && (
                <button className="btn ghost block sm" onClick={() => setShowAll(true)}>More coins ({assets.length}) <ChevronDown size={14} /></button>
              )}

              {asset && (
                <div className="stack rise">
                  <div className="well stack" style={{ marginTop: 0 }}>
                    <div className="row small">
                      <span className="muted">You pay</span>
                      {preview ? <strong className="num">{short(preview.amountInFormatted)} {asset.symbol}</strong> : <Loader2 size={14} className="spin" />}
                    </div>
                    <div className="row small">
                      <span className="muted">≈ in dollars</span>
                      <span className="num">{preview ? `$${Number(preview.amountInUsd).toFixed(2)}` : "…"}</span>
                    </div>
                    {session.feeBps > 0 && (
                      <div className="row tiny muted"><span>Includes {session.feeBps / 100}% service fee and network costs</span><span /></div>
                    )}
                    <hr className="divider" />
                    <div className="row small"><span className="muted">{session.merchant.name} receives</span><strong className="num">${session.amountFormatted}{session.payout ? ` USDC on ${chainName(session.payout.chain)}` : ""}</strong></div>
                  </div>
                  {evm && wallet ? (
                    <button className="btn block" disabled={!preview || busy} onClick={payWithWallet}>
                      {busy ? <><Loader2 size={16} className="spin" /> Confirm in your wallet</> : <><Wallet size={16} /> Pay with wallet</>}
                    </button>
                  ) : (
                    <>
                      <input className="input" placeholder={`Your ${chainName(asset.chain)} address, for refunds`} value={refundTo} onChange={(e) => setRefundTo(e.target.value)} aria-label="Refund address" />
                      <button className="btn block" disabled={!preview || busy || refundTo.trim().length < 10} onClick={payManually}>
                        {busy ? <Loader2 size={16} className="spin" /> : null} Get payment address
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {session.split && !paid && <div className="tiny muted">This payment is split automatically between {session.split.shares.length} recipients, on-chain.</div>}
          {session.escrowId !== null && !paid && <div className="tiny muted">Held in escrow #{session.escrowId} by the Cascade contract and released to {session.merchant.name} milestone by milestone, only with your approval.</div>}
          {error && <div className="error small">{error}</div>}

          <div className="row tiny muted" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <span className="row-start" style={{ gap: 6 }}><ShieldCheck size={14} /> No account needed</span>
            <span className="row-start" style={{ gap: 6 }}><Mark size={12} /> Cascade · NEAR Intents</span>
          </div>
        </div>
      </main>
    </>
  );
}

/** The checkout's layout before data arrives. Also pre-rendered into the static HTML, so it paints at first paint. */
export function CheckoutSkeleton() {
  return (
    <>
      <DemoBanner />
      <main className="narrow" aria-busy="true" aria-label="Loading checkout">
        <div className="card stack-lg">
          <div className="row-start"><Skeleton w={36} h={36} r={12} /><div style={{ flex: 1 }} className="stack"><Skeleton w="45%" h={16} /><Skeleton w="30%" h={12} /></div></div>
          <Skeleton w="50%" h={40} />
          <Skeleton w="60%" h={14} />
          <div className="grid-2 keep-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={62} r={12} />)}</div>
        </div>
      </main>
    </>
  );
}
