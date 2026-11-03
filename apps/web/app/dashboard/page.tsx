"use client";

import { useCallback, useEffect, useState } from "react";
import type { CheckoutSession, RefundInfo } from "@cascade/sdk";

type Webhook = { id: string; type: string; status: string; attempts: number; lastError: string | null; createdAt: string };
type Tab = "sessions" | "webhooks" | "reports";

const KEY = "cascade_dashboard_key";
const read = () => {
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

const badge = (s: string) => <span className={`status ${s === "paid" || s === "delivered" || s === "succeeded" ? "ok" : s === "expired" || s === "failed" ? "bad" : ""}`}><span className="dot" />{s}</span>;

export default function Dashboard() {
  const [key, setKey] = useState("");
  const [input, setInput] = useState("");
  const [me, setMe] = useState<{ name: string; account: string; webhookUrl: string | null } | null>(null);
  const [tab, setTab] = useState<Tab>("sessions");
  const [sessions, setSessions] = useState<CheckoutSession[]>([]);
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [refund, setRefund] = useState<RefundInfo | null>(null);
  const [batchId, setBatchId] = useState("");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [newAmount, setNewAmount] = useState("25.00");
  const [newDesc, setNewDesc] = useState("Test order");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setKey(read()), []);

  const load = useCallback(async () => {
    if (!key) return;
    try {
      setError(null);
      setMe(await call(key, "merchant"));
      setSessions((await call<{ data: CheckoutSession[] }>(key, "checkout/sessions?limit=50")).data);
      setHooks((await call<{ data: Webhook[] }>(key, "webhooks")).data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (f: () => Promise<void>) => {
    try {
      setError(null);
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!key) {
    return (
      <main className="stack">
        <h2>Merchant dashboard</h2>
        <div className="card stack">
          <div className="small muted">Paste your secret key (sk_…). It stays in this tab only and is sent to the Cascade API through this site&apos;s server.</div>
          <input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="sk_live_…" />
          <button className="btn" disabled={!input.startsWith("sk_")} onClick={() => { try { sessionStorage.setItem(KEY, input); } catch { /* private mode */ } setKey(input); }}>Open dashboard</button>
        </div>
      </main>
    );
  }

  return (
    <main className="stack" style={{ maxWidth: 860 }}>
      <div className="row">
        <div>
          <h2 style={{ margin: 0 }}>{me?.name ?? "…"}</h2>
          <div className="small muted">Paid out to <span className="mono">{me?.account}</span>{me?.webhookUrl ? <> · webhooks to <span className="mono">{me.webhookUrl}</span></> : null}</div>
        </div>
        <button className="btn secondary" style={{ width: "auto" }} onClick={() => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } setKey(""); setMe(null); }}>Sign out</button>
      </div>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        {(["sessions", "webhooks", "reports"] as Tab[]).map((t) => (
          <button key={t} className={`btn ${tab === t ? "" : "secondary"}`} style={{ width: "auto" }} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
        ))}
        <button className="btn secondary" style={{ width: "auto", marginLeft: "auto" }} onClick={() => void load()}>Refresh</button>
      </div>
      {error && <div className="card error small">{error}</div>}

      {tab === "sessions" && (
        <div className="stack">
          <div className="card stack">
            <strong>New checkout session</strong>
            <div className="row">
              <input value={newAmount} onChange={(e) => setNewAmount(e.target.value)} aria-label="Amount in USD" style={{ maxWidth: 140 }} />
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} aria-label="Description" />
              <button className="btn" style={{ width: "auto" }} onClick={() => run(async () => {
                const [w, f = ""] = newAmount.trim().split(".");
                if (!/^\d+$/.test(w ?? "") || !/^\d{0,6}$/.test(f)) throw new Error("amount like 25.00");
                const units = (BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0") || "0")).toString();
                await call(key, "checkout/sessions", { amount: units, description: newDesc });
                await load();
              })}>Create</button>
            </div>
          </div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }} className="small">
              <thead><tr className="muted" style={{ textAlign: "left" }}><th>Created</th><th>Amount</th><th>Description</th><th>Status</th><th /></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} style={{ borderTop: "1px solid var(--line)" }}>
                    <td>{new Date(s.createdAt).toLocaleString()}</td>
                    <td>${s.amountFormatted}</td>
                    <td>{s.description}{s.reference ? <span className="muted"> · {s.reference}</span> : null}{s.split ? <span className="muted"> · split</span> : null}</td>
                    <td>{badge(s.status)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {s.status === "open" && <a href={`/c/${s.id}`} target="_blank" rel="noreferrer">Pay page</a>}
                      {s.status === "paid" && <><a href={`/r/${s.id}`} target="_blank" rel="noreferrer">Receipt</a> · <a href="#" onClick={(e) => { e.preventDefault(); void run(async () => setRefund(await call(key, `checkout/sessions/${s.id}/refunds`, {}))); }}>Refund</a></>}
                    </td>
                  </tr>
                ))}
                {sessions.length === 0 && <tr><td colSpan={5} className="muted">No sessions yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {refund && (
            <div className="card stack">
              <div className="row"><strong>Refund {refund.id}: ${(Number(refund.amount) / 1e6).toFixed(2)}</strong>{badge(refund.status)}</div>
              <div className="small muted">Goes back to <span className="mono">{refund.lines[0]?.dest}</span>, in the coin the customer paid with. Sign these with your NEAR wallet or key, in order. Cascade cannot sign them for you.</div>
              <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(refund.calls, null, 2)}</pre>
              {refund.status === "awaiting_batch" && (
                <div className="row">
                  <input placeholder="batch id returned by create_batch" value={batchId} onChange={(e) => setBatchId(e.target.value)} />
                  <button className="btn" style={{ width: "auto" }} onClick={() => run(async () => setRefund(await call(key, `refunds/${refund.id}/confirm`, { batchId: Number(batchId) })))}>Confirm batch</button>
                </div>
              )}
              <button className="btn secondary" onClick={() => run(async () => setRefund(await call(key, `refunds/${refund.id}`)))}>Refresh refund</button>
            </div>
          )}
        </div>
      )}

      {tab === "webhooks" && (
        <div className="card" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }} className="small">
            <thead><tr className="muted" style={{ textAlign: "left" }}><th>When</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th><th /></tr></thead>
            <tbody>
              {hooks.map((h) => (
                <tr key={h.id} style={{ borderTop: "1px solid var(--line)" }}>
                  <td>{new Date(h.createdAt).toLocaleString()}</td>
                  <td className="mono">{h.type}</td>
                  <td>{badge(h.status)}</td>
                  <td>{h.attempts}</td>
                  <td className="muted">{h.lastError ?? ""}</td>
                  <td>{h.status !== "delivered" && <a href="#" onClick={(e) => { e.preventDefault(); void run(async () => { await call(key, `webhooks/${h.id}/retry`, {}); await load(); }); }}>Retry</a>}</td>
                </tr>
              ))}
              {hooks.length === 0 && <tr><td colSpan={6} className="muted">No webhooks yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "reports" && (
        <div className="card stack">
          <strong>Accountant CSV</strong>
          <div className="small muted">One row per payment in or out: date, counterparty, gross, fee, net, rate, chains, transactions.</div>
          <div className="row">
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 200 }} />
            <button className="btn" style={{ width: "auto" }} onClick={() => run(async () => {
              const r = await fetch(`/api/dashboard/reports/ledger.csv?month=${month}`, { headers: { "x-cascade-key": key } });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const url = URL.createObjectURL(await r.blob());
              const a = document.createElement("a");
              a.href = url;
              a.download = `cascade-${month}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            })}>Download CSV</button>
          </div>
        </div>
      )}
    </main>
  );
}
