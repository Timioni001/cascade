"use client";

import { useEffect, useState } from "react";
import { API } from "../../lib/api";

/**
 * Operator view: platform stats, live-access applications and every merchant.
 * Not linked from anywhere. The token is the CASCADE_ADMIN_TOKEN secret and
 * stays in this tab (sessionStorage) only.
 */
type Status = "received" | "reviewing" | "approved" | "rejected";
const STATUSES: Status[] = ["received", "reviewing", "approved", "rejected"];
interface App { id: string; company: string; website: string | null; email: string; country: string | null; monthlyVolume: string | null; useCase: string; nearAccount: string | null; createdAt: string; status: Status; reviewedAt?: string | null; note?: string | null }

/** Applications as a spreadsheet file, for a CRM or a shared sheet. */
function downloadCsv(apps: App[]) {
  const cols = ["createdAt", "status", "company", "email", "website", "country", "monthlyVolume", "nearAccount", "useCase", "note", "id"] as const;
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...apps.map((a) => cols.map((c) => cell(a[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const el = Object.assign(document.createElement("a"), { href: url, download: `cascade-applications-${new Date().toISOString().slice(0, 10)}.csv` });
  el.click();
  URL.revokeObjectURL(url);
}

interface Overview {
  network: string;
  feeBps: number;
  generatedAt: string;
  stats: Record<string, number>;
  applications: App[];
  merchants: { id: string; name: string; account: string; createdAt: string; sandbox: boolean; webhook: boolean; payout: string; sessions: number; paid: number; volumeUsd: number; lastActivity: string | null }[];
}

const KEY = "cascade-admin";
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const when = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

export default function Admin() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"apps" | "merchants">("apps");
  const [hideSandbox, setHideSandbox] = useState(false);
  const [filter, setFilter] = useState<Status | "all">("all");

  async function setStatus(a: App, status: Status) {
    setError(null);
    try {
      const r = await fetch(`${API}/api/admin/applications/${a.id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ status }) });
      const j = (await r.json().catch(() => ({}))) as App & { error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      setData((d) => d && { ...d, applications: d.applications.map((x) => (x.id === a.id ? j : x)), stats: { ...d.stats, newApplications: d.applications.map((x) => (x.id === a.id ? j : x)).filter((x) => x.status === "received").length } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function load(t: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/admin/overview`, { headers: { authorization: `Bearer ${t}` } });
      const j = (await r.json().catch(() => ({}))) as Overview & { error?: { message: string } };
      if (r.status === 404) throw new Error("The admin view is off on this server: set the CASCADE_ADMIN_TOKEN secret.");
      if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      setData(j);
      try { sessionStorage.setItem(KEY, t); } catch {}
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let saved = "";
    try { saved = sessionStorage.getItem(KEY) ?? ""; } catch {}
    if (saved) { setToken(saved); void load(saved); }
  }, []);

  // New applications show up without a reload.
  useEffect(() => {
    if (!data || !token) return;
    const t = setInterval(() => void load(token), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data, token]);

  if (!data) {
    return (
      <main className="container page" style={{ maxWidth: 420, marginTop: "12vh" }}>
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void load(token.trim()); }}>
          <h1 className="admin-title">Admin</h1>
          <input className="input" type="password" autoComplete="off" placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn" disabled={busy || !token.trim()}>{busy ? "Checking…" : "Open"}</button>
          {error && <p className="tiny error">{error}</p>}
        </form>
      </main>
    );
  }

  const s = data.stats;
  const tiles: [string, string][] = [
    ["New applications", `${s.newApplications ?? 0}`], ["Applications", `${s.applications}`], ["Merchants", `${s.merchants}`], ["Sandbox accounts", `${s.sandboxMerchants}`],
    ["Payments", `${s.paid} / ${s.sessions}`], ["Volume", money(s.volumeUsd ?? 0)], ["Last 24h", money(s.volume24hUsd ?? 0)], ["Paid in 24h", `${s.paid24h}`],
    [`Fees (${(data.feeBps / 100).toFixed(2)}%)`, money(s.feesUsd ?? 0)], ["Invoices", `${s.invoices}`],
    ["Active subscriptions", `${s.activeSubscriptions}`], ["Open refunds", `${s.openRefunds}`],
  ];
  const merchants = hideSandbox ? data.merchants.filter((m) => !m.sandbox) : data.merchants;

  return (
    <main className="container page stack-lg">
      <div className="row">
        <h1 className="admin-title">Admin <span className="tiny muted">{data.network} · {when(data.generatedAt)}</span></h1>
        <span className="row-start">
          <button className="btn ghost sm" onClick={() => void load(token)} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
          <button className="btn ghost sm" onClick={() => { try { sessionStorage.removeItem(KEY); } catch {} setData(null); setToken(""); }}>Sign out</button>
        </span>
      </div>

      <div className="admin-tiles">
        {tiles.map(([k, v]) => (
          <div key={k} className="card"><div className="tiny muted">{k}</div><div className="amount num">{v}</div></div>
        ))}
      </div>

      <div className="row-start">
        <button className={`btn sm ${tab === "apps" ? "" : "ghost"}`} onClick={() => setTab("apps")}>Applications ({data.applications.length}{s.newApplications ? `, ${s.newApplications} new` : ""})</button>
        <button className={`btn sm ${tab === "merchants" ? "" : "ghost"}`} onClick={() => setTab("merchants")}>Merchants ({data.merchants.length})</button>
        {tab === "apps" && (
          <>
            <select className="input" style={{ width: "auto", height: 34 }} value={filter} onChange={(e) => setFilter(e.target.value as Status | "all")} aria-label="Filter by status">
              <option value="all">All statuses</option>
              {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <button className="btn ghost sm" onClick={() => downloadCsv(data.applications)} disabled={!data.applications.length}>Export CSV</button>
          </>
        )}
        {tab === "merchants" && (
          <label className="small soft"><input type="checkbox" checked={hideSandbox} onChange={(e) => setHideSandbox(e.target.checked)} /> Hide sandbox</label>
        )}
      </div>

      <div className="card admin-scroll">
        {tab === "apps" ? (
          data.applications.length === 0 ? <p className="muted small">No applications yet. They arrive from “Go live” on /start.</p> : (
            <table className="table">
              <thead><tr><th>Received</th><th>Status</th><th>Company</th><th>Contact</th><th>Country</th><th>Volume / mo</th><th>NEAR account</th><th>Use case</th></tr></thead>
              <tbody>
                {data.applications.filter((a) => filter === "all" || a.status === filter).map((a) => (
                  <tr key={a.id} style={a.status === "received" ? { background: "var(--card-2)" } : undefined}>
                    <td className="tiny num">{when(a.createdAt)}</td>
                    <td>
                      <select className="input" style={{ height: 32, width: 120, fontSize: 13 }} value={a.status} onChange={(e) => void setStatus(a, e.target.value as Status)} aria-label={`Status of ${a.company}`}>
                        {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </td>
                    <td><strong>{a.company}</strong>{a.website && <div className="tiny"><a href={a.website.startsWith("http") ? a.website : `https://${a.website}`} target="_blank" rel="noreferrer noopener">{a.website}</a></div>}</td>
                    <td className="small"><a href={`mailto:${a.email}`}>{a.email}</a></td>
                    <td className="small">{a.country ?? "—"}</td>
                    <td className="small">{a.monthlyVolume ?? "—"}</td>
                    <td className="tiny mono">{a.nearAccount ?? "—"}</td>
                    <td className="small admin-wrap">{a.useCase}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <table className="table">
            <thead><tr><th>Joined</th><th>Business</th><th>NEAR account</th><th>Payments</th><th>Volume</th><th>Payout</th><th>Webhook</th><th>Last activity</th></tr></thead>
            <tbody>
              {merchants.map((m) => (
                <tr key={m.id}>
                  <td className="tiny num">{when(m.createdAt)}</td>
                  <td><strong>{m.name}</strong> {m.sandbox && <span className="tiny muted">sandbox</span>}<div className="tiny muted mono">{m.id}</div></td>
                  <td className="tiny mono">{m.account}</td>
                  <td className="num">{m.paid} / {m.sessions}</td>
                  <td className="num">{money(m.volumeUsd)}</td>
                  <td className="small">{m.payout}</td>
                  <td className="small">{m.webhook ? "yes" : "—"}</td>
                  <td className="tiny num">{when(m.lastActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
