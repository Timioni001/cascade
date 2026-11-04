"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, ShieldCheck } from "lucide-react";
import { Badge, chainName } from "../components/ui";
import { call } from "./api";

type Key = { prefix: string; role: "full" | "read"; label: string | null; createdAt: string; revokedAt: string | null };
type Props = { secret: string; payout: { chain: string; address: string } | null; account: string; onError: (m: string | null) => void };

/** Team access (API keys with roles) and where payments settle. */
export function SettingsTab({ secret, payout, account, onError }: Props) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [label, setLabel] = useState("Accountant");
  const [fresh, setFresh] = useState<string | null>(null);
  const load = useCallback(() => call<{ data: Key[] }>(secret, "merchant/keys").then((r) => setKeys(r.data), (e: Error) => onError(e.message)), [secret, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (f: () => Promise<unknown>) => {
    onError(null);
    try {
      await f();
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="dash-two" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)", gap: 16, alignItems: "start" }}>
      <div className="card stack">
        <div className="row"><div className="h2">Team access</div><KeyRound size={18} className="muted" /></div>
        <p className="small soft" style={{ margin: 0 }}>Give an accountant or a support tool a read-only key (rk_…): it can see payments, invoices and reports, and cannot create, refund or change anything.</p>
        {keys === null ? <div className="muted small">Loading…</div> : (
          <table className="table">
            <thead><tr><th>Key</th><th>Role</th><th>Created</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.prefix}>
                  <td><span className="mono">{k.prefix}…</span>{k.label && <div className="tiny muted">{k.label}</div>}</td>
                  <td><Badge tone={k.revokedAt ? "neutral" : k.role === "full" ? "warn" : "ok"}>{k.revokedAt ? "revoked" : k.role === "full" ? "full access" : "read-only"}</Badge></td>
                  <td className="small soft">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: "right" }}>{!k.revokedAt && <button className="btn ghost sm" onClick={() => act(() => call(secret, `merchant/keys/${k.prefix}/revoke`, {}))}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row-start">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label for the new key" />
          <button className="btn" onClick={() => act(async () => setFresh((await call<{ key: string }>(secret, "merchant/keys", { role: "read", label })).key))}>New read-only key</button>
        </div>
        {fresh && (
          <div className="well row small">
            <span className="mono">{fresh}</span>
            <button className="icon-btn" aria-label="Copy key" onClick={() => navigator.clipboard?.writeText(fresh)}><Copy size={14} /></button>
          </div>
        )}
        {fresh && <div className="tiny muted">Shown once. Only a hash is stored.</div>}
      </div>

      <div className="card stack">
        <div className="row"><div className="h2">Payouts</div><ShieldCheck size={18} className="muted" /></div>
        <div className="well stack" style={{ gap: 4 }}>
          <div className="tiny muted">Payments settle as</div>
          <div style={{ fontWeight: 600 }}>USDC on {payout ? chainName(payout.chain) : "NEAR"}</div>
          <div className="mono tiny soft">{payout?.address ?? account}</div>
        </div>
        <p className="small soft" style={{ margin: 0 }}>
          Choose USDC on NEAR, Ethereum, Base, Arbitrum or Solana. Changing it needs a signature from <span className="mono">{account}</span> (NEP-413), so a leaked API key cannot redirect your money.
          Revenue splits and escrow always settle on NEAR, where the contract holds and divides the money.
        </p>
        <pre className="mono tiny" style={{ margin: 0, background: "var(--card-2)", borderRadius: "var(--r-md)", padding: 12, whiteSpace: "pre-wrap" }}>{`await cascade.merchant.setPayout(
  { chain: "base", address: "0x…" },
  await wallet.signMessage(payoutMessage(…)),
)`}</pre>
      </div>
    </div>
  );
}
