"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Download, FileText, LayoutGrid, Link2, Loader2, LogOut, Plus, ReceiptText, RefreshCw, Undo2, Webhook } from "lucide-react";
import type { CheckoutSession, RefundInfo } from "@cascade/sdk";
import { Badge, Brand, DemoBanner, toneOf, usd } from "../components/ui";

type Webhook = { id: string; type: string; status: string; attempts: number; lastError: string | null; createdAt: string };
type Me = { name: string; account: string; webhookUrl: string | null };
type Tab = "overview" | "payments" | "webhooks" | "reports";

const KEY = "cascade_dashboard_key";
const readKey = () => {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

async function call<T>(key: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/dashboard/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-cascade-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

/** Revenue per day for the last 7 days, from paid sessions. */
function lastWeek(sessions: CheckoutSession[]) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (6 - i));
    return { date: d, label: d.toLocaleDateString("en-US", { weekday: "short" }), total: 0 };
  });
  for (const s of sessions) {
    if (s.status !== "paid" || !s.paidAt) continue;
    const t = new Date(s.paidAt);
    t.setHours(0, 0, 0, 0);
    const day = days.find((d) => d.date.getTime() === t.getTime());
    if (day) day.total += Number(s.amount);
  }
  return days;
}

function Chart({ sessions }: { sessions: CheckoutSession[] }) {
  const days = lastWeek(sessions);
  const max = Math.max(...days.map((d) => d.total), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 180, paddingTop: 12 }} role="img" aria-label="Revenue for the last 7 days">
      {days.map((d, i) => {
        const today = i === days.length - 1;
        return (
          <div key={d.label + i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, height: "100%", justifyContent: "flex-end" }}>
            <div className="tiny muted num" style={{ opacity: d.total ? 1 : 0 }}>{usd(d.total)}</div>
            <div title={usd(d.total)} style={{ width: "100%", maxWidth: 46, height: `${Math.max(6, (d.total / max) * 130)}px`, borderRadius: 999, background: today ? "var(--accent)" : d.total ? "#3a3a3f" : "var(--card-2)", transition: "height .4s ease" }} />
            <div className="tiny" style={{ color: today ? "var(--ink)" : "var(--muted)" }}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function SessionsTable({ sessions, onRefund, compact }: { sessions: CheckoutSession[]; onRefund?: (s: CheckoutSession) => void; compact?: boolean }) {
  if (sessions.length === 0) return <div className="muted small" style={{ padding: "24px 0" }}>No payments yet. Share a checkout link to get paid.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="table">
        <thead><tr><th>Payment</th><th>Date</th><th>Status</th><th style={{ textAlign: "right" }}>Amount</th>{!compact && <th />}</tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <div style={{ fontWeight: 500 }}>{s.description}</div>
                <div className="tiny muted">{s.reference ?? s.id}{s.split ? " · split" : ""}</div>
              </td>
              <td className="small soft">{new Date(s.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, {new Date(s.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</td>
              <td><Badge tone={toneOf(s.status)}>{s.status}</Badge></td>
              <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>{usd(s.amount)}</td>
              {!compact && (
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {s.status === "open" && <a className="btn ghost sm" href={`/c/${s.id}`} target="_blank" rel="noreferrer"><Link2 size={14} /> Pay link</a>}
                  {s.status === "paid" && (
                    <span className="row-start" style={{ justifyContent: "flex-end", gap: 6 }}>
                      <a className="btn ghost sm" href={`/r/${s.id}`} target="_blank" rel="noreferrer"><ReceiptText size={14} /> Receipt</a>
                      {onRefund && <button className="btn ghost sm" onClick={() => onRefund(s)}><Undo2 size={14} /> Refund</button>}
                    </span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const [key, setKey] = useState("");
  const [input, setInput] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [sessions, setSessions] = useState<CheckoutSession[]>([]);
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [refund, setRefund] = useState<RefundInfo | null>(null);
  const [batchId, setBatchId] = useState("");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [amount, setAmount] = useState("25.00");
  const [desc, setDesc] = useState("Design work");
  const [created, setCreated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setKey(readKey()), []);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      setError(null);
      setMe(await call(key, "merchant"));
      const [s, h, b] = await Promise.all([
        call<{ data: CheckoutSession[] }>(key, "checkout/sessions?limit=100"),
        call<{ data: Webhook[] }>(key, "webhooks"),
        call<{ usdc: string }>(key, "merchant/balance").catch(() => null),
      ]);
      setSessions(s.data);
      setHooks(h.data);
      setBalance(b?.usdc ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const paid = sessions.filter((s) => s.status === "paid");
    const week = lastWeek(sessions).reduce((t, d) => t + d.total, 0);
    const settled = sessions.filter((s) => s.status === "paid" || s.status === "expired").length;
    return { paid: paid.length, week, avg: paid.length ? paid.reduce((t, s) => t + Number(s.amount), 0) / paid.length : 0, rate: settled ? Math.round((paid.length / settled) * 100) : null };
  }, [sessions]);

  const run = async (f: () => Promise<void>) => {
    try {
      setError(null);
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const signOut = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* private mode */
    }
    setKey("");
    setMe(null);
  };

  if (!key) {
    return (
      <div className="page">
        <DemoBanner />
        <main className="narrow stack-lg" style={{ paddingTop: 80 }}>
          <Brand />
          <div className="card raised stack-lg">
            <div>
              <h1 className="h1">Merchant dashboard</h1>
              <p className="soft small" style={{ margin: "8px 0 0" }}>Paste your secret key (sk_…). It stays in this browser tab and is sent to the Cascade API through this site&apos;s server.</p>
            </div>
            <input className="input" type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="sk_live_…" aria-label="Secret key" />
            <button className="btn block" disabled={!input.startsWith("sk_")} onClick={() => { try { sessionStorage.setItem(KEY, input); } catch { /* private mode */ } setKey(input); }}>Open dashboard</button>
          </div>
        </main>
      </div>
    );
  }

  const nav: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "payments", label: "Payments", icon: FileText },
    { id: "webhooks", label: "Webhooks", icon: Webhook },
    { id: "reports", label: "Reports", icon: Download },
  ];

  return (
    <div className="page">
      <DemoBanner />
      <div style={{ display: "grid", gridTemplateColumns: "232px minmax(0,1fr)", minHeight: "100vh" }} className="dash">
        <aside style={{ borderRight: "1px solid var(--line)", padding: 20, display: "flex", flexDirection: "column", gap: 24, position: "sticky", top: 0, height: "100vh" }} className="dash-side">
          <Brand />
          <nav style={{ display: "grid", gap: 4 }} aria-label="Dashboard">
            {nav.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined} className="row-start"
                style={{ height: 42, padding: "0 14px", borderRadius: 999, border: 0, cursor: "pointer", background: tab === id ? "var(--card-2)" : "transparent", color: tab === id ? "var(--ink)" : "var(--muted)", fontWeight: tab === id ? 600 : 500 }}>
                <Icon size={17} /> {label}
              </button>
            ))}
          </nav>
          <button onClick={signOut} className="row-start muted" style={{ marginTop: "auto", background: "transparent", border: 0, cursor: "pointer", padding: "0 14px" }}><LogOut size={16} /> Sign out</button>
        </aside>

        <main style={{ padding: "28px 32px 48px", minWidth: 0 }} className="stack-lg">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <div>
              <div className="h1">{greeting()}, {me?.name ?? "…"}</div>
              <div className="small muted" style={{ marginTop: 4 }}>Paid out to <span className="mono">{me?.account}</span></div>
            </div>
            <div className="row-start">
              <button className="icon-btn" onClick={() => void load()} aria-label="Refresh">{loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}</button>
              <button className="btn sm" onClick={() => setTab("payments")}><Plus size={15} /> New payment link</button>
            </div>
          </div>
          {error && <div className="card tight error small">{error}</div>}

          {tab === "overview" && (
            <>
              <div className="grid-3">
                <div className="card stack" style={{ background: "var(--accent)", color: "var(--accent-ink)", borderColor: "transparent" }}>
                  <div className="row small" style={{ fontWeight: 600 }}>Balance <span className="tiny">USDC on NEAR</span></div>
                  <div className="amount num">{balance === null ? "…" : usd(balance)}</div>
                  <div className="tiny" style={{ opacity: 0.7 }}>In your own account. Cascade never holds it.</div>
                </div>
                <div className="card stack">
                  <div className="row small muted">Last 7 days</div>
                  <div className="amount num">{usd(stats.week)}</div>
                  <div className="tiny muted">{stats.paid} paid · avg {usd(stats.avg)}</div>
                </div>
                <div className="card stack">
                  <div className="row small muted">Paid vs. expired</div>
                  <div className="amount num">{stats.rate === null ? "—" : `${stats.rate}%`}</div>
                  <div className="tiny muted">{sessions.length} {sessions.length === 1 ? "session" : "sessions"} in total</div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr)", gap: 16 }} className="dash-two">
                <div className="card">
                  <div className="row"><div className="h2">Revenue</div><span className="pill">This week</span></div>
                  <Chart sessions={sessions} />
                </div>
                <div className="card">
                  <div className="row"><div className="h2">Recent payments</div><button className="btn ghost sm" onClick={() => setTab("payments")}>All <ArrowUpRight size={14} /></button></div>
                  <SessionsTable sessions={sessions.slice(0, 5)} compact />
                </div>
              </div>
            </>
          )}

          {tab === "payments" && (
            <>
              <div className="card stack-lg">
                <div className="h2">New payment link</div>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in USD" style={{ maxWidth: 160 }} />
                  <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Description" style={{ flex: 1, minWidth: 200 }} />
                  <button className="btn" onClick={() => run(async () => {
                    const [w, f = ""] = amount.trim().replace(/^\$/, "").split(".");
                    if (!/^\d+$/.test(w ?? "") || !/^\d{0,6}$/.test(f)) throw new Error("amount like 25.00");
                    const units = (BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0") || "0")).toString();
                    const s = await call<CheckoutSession>(key, "checkout/sessions", { amount: units, description: desc });
                    setCreated(s.url);
                    await load();
                  })}>Create</button>
                </div>
                {created && (
                  <div className="well row small">
                    <span className="mono">{created}</span>
                    <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(created)}>Copy</button>
                  </div>
                )}
              </div>
              <div className="card">
                <div className="h2" style={{ marginBottom: 8 }}>Payments</div>
                <SessionsTable sessions={sessions} onRefund={(s) => void run(async () => setRefund(await call(key, `checkout/sessions/${s.id}/refunds`, {})))} />
              </div>
              {refund && (
                <div className="card stack-lg rise">
                  <div className="row"><div className="h2">Refund {usd(refund.amount)}</div><Badge tone={toneOf(refund.status)}>{refund.status.replace(/_/g, " ")}</Badge></div>
                  <p className="soft small" style={{ margin: 0 }}>Goes back to <span className="mono">{refund.lines[0]?.dest}</span>, in the coin the customer paid with. Sign these calls with your NEAR wallet or key, in order. Cascade cannot sign them for you.</p>
                  <pre className="mono" style={{ margin: 0, padding: 16, background: "var(--bg)", borderRadius: "var(--r-md)", border: "1px solid var(--line)", whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>{JSON.stringify(refund.calls, null, 2)}</pre>
                  {refund.status === "awaiting_batch" && (
                    <div className="row">
                      <input className="input" placeholder="Batch id returned by create_batch" value={batchId} onChange={(e) => setBatchId(e.target.value)} />
                      <button className="btn" onClick={() => run(async () => setRefund(await call(key, `refunds/${refund.id}/confirm`, { batchId: Number(batchId) })))}>Confirm</button>
                    </div>
                  )}
                  <button className="btn ghost sm" onClick={() => run(async () => setRefund(await call(key, `refunds/${refund.id}`)))}><RefreshCw size={14} /> Refresh refund</button>
                </div>
              )}
            </>
          )}

          {tab === "webhooks" && (
            <div className="card">
              <div className="row" style={{ marginBottom: 8 }}><div className="h2">Webhooks</div><span className="tiny muted mono">{me?.webhookUrl ?? "no URL set"}</span></div>
              {hooks.length === 0 ? <div className="muted small" style={{ padding: "24px 0" }}>No webhooks yet.</div> : (
                <div style={{ overflowX: "auto" }}>
                  <table className="table">
                    <thead><tr><th>Event</th><th>When</th><th>Status</th><th>Attempts</th><th /></tr></thead>
                    <tbody>
                      {hooks.map((h) => (
                        <tr key={h.id}>
                          <td><span className="mono">{h.type}</span>{h.lastError && <div className="tiny error">{h.lastError}</div>}</td>
                          <td className="small soft">{new Date(h.createdAt).toLocaleString()}</td>
                          <td><Badge tone={toneOf(h.status)}>{h.status}</Badge></td>
                          <td className="num">{h.attempts}</td>
                          <td style={{ textAlign: "right" }}>{h.status !== "delivered" && <button className="btn ghost sm" onClick={() => void run(async () => { await call(key, `webhooks/${h.id}/retry`, {}); await load(); })}>Retry</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === "reports" && (
            <div className="card stack-lg" style={{ maxWidth: 560 }}>
              <div className="h2">Accountant CSV</div>
              <p className="soft small" style={{ margin: 0 }}>One row per payment in or out: date, counterparty, gross, fee, net, rate, chains and transactions. Opens in any spreadsheet.</p>
              <div className="row">
                <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 200 }} aria-label="Month" />
                <button className="btn" onClick={() => run(async () => {
                  const r = await fetch(`/api/dashboard/reports/ledger.csv?month=${month}`, { headers: { "x-cascade-key": key } });
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  const url = URL.createObjectURL(await r.blob());
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `cascade-${month}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                })}><Download size={15} /> Download CSV</button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
