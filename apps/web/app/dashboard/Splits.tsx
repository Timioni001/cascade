"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Plus, Split, Trash2, Users } from "lucide-react";
import { Badge, usd } from "../components/ui";
import { call } from "./api";
import { callContractValue, getDeployment } from "../../lib/wallet";
import { useWallet, WalletBar } from "./Wallet";

type SplitView = { id: number; owner: string; createdBy: string; createdAt: string; shares: { account: string; bps: number }[]; payments: number; received: string };
type Props = { secret: string; account: string; onError: (m: string | null) => void };

/** Sputnik DAO accounts live under the DAO factory (sputnik-dao.near, sputnikv2.testnet, ...). */
const isDao = (a: string) => /\.(sputnik-dao\.near|sputnikv2\.testnet)$|sputnik-dao\./.test(a);
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

/**
 * Revenue splits: every payment into a split is divided by the contract the
 * moment it arrives, between people and community treasuries (a Sputnik DAO
 * can be a share). Created with the merchant's own wallet; paid through any
 * checkout link with the split attached.
 */
export function SplitsTab({ secret, account, onError }: Props) {
  const [data, setData] = useState<SplitView[] | null>(null);
  const [links, setLinks] = useState<Record<number, string>>({});
  const [amount, setAmount] = useState<Record<number, string>>({});
  const [rows, setRows] = useState<{ account: string; percent: string }[]>([{ account, percent: "80" }, { account: "", percent: "15" }, { account: "", percent: "5" }]);
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const wallet = useWallet();

  const load = useCallback(() => call<{ data: SplitView[] }>(secret, "merchant/splits").then((r) => setData(r.data), (e: Error) => onError(e.message)), [secret, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const total = rows.reduce((t, r) => t + (Number(r.percent) || 0), 0);

  async function create() {
    onError(null);
    setBusy(true);
    try {
      const shares = rows.map((r) => ({ account: r.account.trim(), bps: Math.round(Number(r.percent) * 100) }));
      if (shares.some((s) => !s.account || !(s.bps > 0))) throw new Error("every share needs a NEAR account and a percentage above 0");
      if (shares.reduce((t, s) => t + s.bps, 0) !== 10_000) throw new Error("shares must add up to exactly 100%");
      const { app } = await getDeployment();
      const rule = await callContractValue<{ id: number }>({ contract: app, method: "create_split", args: { owner: account, shares } });
      await call(secret, "merchant/splits", { id: rule.id });
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addExisting() {
    onError(null);
    try {
      await call(secret, "merchant/splits", { id: Number(existing) });
      setExisting("");
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function paymentLink(s: SplitView) {
    onError(null);
    try {
      const v = (amount[s.id] ?? "50.00").trim().replace(/^\$/, "");
      const [w, f = ""] = v.split(".");
      if (!/^\d+$/.test(w ?? "") || !/^\d{0,6}$/.test(f)) throw new Error("amount like 50.00");
      const units = (BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6))).toString();
      const r = await call<{ url: string }>(secret, "checkout/sessions", { amount: units, description: `Payment into split #${s.id}`, splitId: s.id, expiresInMinutes: 1440 });
      setLinks({ ...links, [s.id]: r.url.replace(/^https?:\/\/[^/]+/, "") });
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="row"><div className="h2">Revenue splits</div><Split size={18} className="muted" /></div>
        <p className="small soft" style={{ margin: 0 }}>
          Share every sale on arrival: partners, collaborators and community treasuries each receive their part from the NEAR contract the moment a payment lands, with no one holding the money in between. A Sputnik DAO can be a share, so a collective earns directly into its treasury.
        </p>
        {data === null ? <div className="muted small">Loading…</div> : data.length === 0 ? (
          <div className="small muted" style={{ padding: "18px 0" }}>No splits yet. Create one below with your wallet.</div>
        ) : data.map((s) => (
          <div key={s.id} className="well stack" style={{ gap: 12 }}>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600 }}>Split #{s.id}</div>
                <div className="tiny muted">Created {new Date(s.createdAt).toLocaleDateString()} · {s.payments} payment{s.payments === 1 ? "" : "s"} · {usd(s.received)} received through checkout</div>
              </div>
              <Badge tone="ok">on-chain</Badge>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {s.shares.map((sh) => (
                <div key={sh.account} className="row small" style={{ gap: 12 }}>
                  <span className="row-start" style={{ gap: 8, minWidth: 0 }}>
                    {isDao(sh.account) ? <Users size={14} /> : <span style={{ width: 14 }} />}
                    <span className="mono" style={{ overflowWrap: "anywhere" }}>{sh.account}</span>
                    {isDao(sh.account) && <Badge tone="neutral">DAO treasury</Badge>}
                    {sh.account === account && <Badge tone="neutral">you</Badge>}
                  </span>
                  <span className="row-start" style={{ gap: 10, flex: "none" }}>
                    <span style={{ width: 120, height: 6, borderRadius: 999, background: "var(--card)", overflow: "hidden", display: "inline-block" }}>
                      <span style={{ display: "block", height: "100%", width: `${sh.bps / 100}%`, background: "var(--ink)" }} />
                    </span>
                    <span className="num" style={{ width: 48, textAlign: "right", fontWeight: 600 }}>{pct(sh.bps)}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="row-start" style={{ flexWrap: "wrap" }}>
              <input className="input" style={{ width: 120 }} value={amount[s.id] ?? "50.00"} onChange={(e) => setAmount({ ...amount, [s.id]: e.target.value })} aria-label={`Amount for split ${s.id}`} />
              {links[s.id]
                ? <a className="btn ghost sm" href={links[s.id]} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open the payment link</a>
                : <button className="btn sm" onClick={() => paymentLink(s)}>Create a payment link into this split</button>}
            </div>
          </div>
        ))}
      </div>

      <div className="card stack">
        <div className="h2">New split</div>
        <WalletBar wallet={wallet} owner={account} onError={onError} why={`Your wallet (${account}) creates the split on the contract.`} />
        {rows.map((r, i) => (
          <div key={i} className="row-start" style={{ flexWrap: "wrap" }}>
            <input className="input mono" style={{ flex: 1, minWidth: 220 }} placeholder="NEAR account or DAO (e.g. makers.sputnik-dao.near)" value={r.account} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))} aria-label={`Share ${i + 1} account`} autoComplete="off" spellCheck={false} />
            <input className="input" style={{ width: 90 }} inputMode="decimal" value={r.percent} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} aria-label={`Share ${i + 1} percent`} />
            <span className="small muted">%</span>
            <button className="icon-btn" aria-label={`Remove share ${i + 1}`} disabled={rows.length <= 2} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="row">
          <button className="btn ghost sm" disabled={rows.length >= 10} onClick={() => setRows([...rows, { account: "", percent: "" }])}><Plus size={14} /> Add a share</button>
          <span className={`small ${total === 100 ? "muted" : "error"}`}>Total {total}%{total === 100 ? "" : " (must be 100%)"}</span>
        </div>
        <div className="row-start">
          <button className="btn" disabled={busy || !wallet.account || wallet.account !== account || total !== 100} onClick={create}>{busy ? "Waiting for your wallet…" : "Create split"}</button>
          <span className="tiny muted">Up to 10 shares, adding up to 100%. One signature from your wallet.</span>
        </div>
        <div className="row-start" style={{ borderTop: "1px solid var(--line)", paddingTop: 14, flexWrap: "wrap" }}>
          <span className="small muted">Already created one on-chain?</span>
          <input className="input" style={{ width: 120 }} inputMode="numeric" placeholder="Split id" value={existing} onChange={(e) => setExisting(e.target.value)} aria-label="Existing split id" />
          <button className="btn ghost sm" disabled={!/^\d+$/.test(existing)} onClick={addExisting}>Add</button>
        </div>
      </div>
    </div>
  );
}
