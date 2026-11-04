"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, ExternalLink, Plus, Trash2 } from "lucide-react";
import type { CustomerSummary, Interval, Invoice, Plan, Subscription } from "@cascade/sdk";
import { Badge, toneOf, usd } from "../components/ui";
import { call } from "./api";

type Props = { secret: string; onError: (m: string | null) => void };

/** "12.50" -> "12500000" (USDC base units). */
function units(d: string): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(d.trim());
  if (!m) throw new Error(`"${d}" is not an amount`);
  return (BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

function useList<T>(secret: string, path: string, onError: Props["onError"]) {
  const [data, setData] = useState<T[] | null>(null);
  const load = useCallback(() => call<{ data: T[] }>(secret, path).then((r) => setData(r.data), (e: Error) => onError(e.message)), [secret, path, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, load };
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="muted small" style={{ padding: "20px 0" }}>{children}</div>;
}

function invoiceTone(i: Invoice) {
  return i.status === "open" && i.overdue ? "bad" : i.status === "void" ? "neutral" : toneOf(i.status === "open" ? "pending" : i.status);
}

// ------------------------------------------------------------ invoices

export function InvoicesTab({ secret, onError }: Props) {
  const { data, load } = useList<Invoice>(secret, "invoices", onError);
  const [name, setName] = useState("Fieldwork Café");
  const [email, setEmail] = useState("orders@fieldwork.example");
  const [items, setItems] = useState([{ description: "Stoneware mug", quantity: "24", price: "18.00" }, { description: "Shipping", quantity: "1", price: "35.00" }]);
  const [days, setDays] = useState("14");
  const [busy, setBusy] = useState(false);

  const total = items.reduce((t, it) => {
    try {
      return t + Number(units(it.price)) * Number(it.quantity || 0);
    } catch {
      return t;
    }
  }, 0);

  async function create() {
    setBusy(true);
    onError(null);
    try {
      await call(secret, "invoices", {
        customer: { name, ...(email ? { email } : {}) },
        items: items.map((it) => ({ description: it.description, quantity: Number(it.quantity), unitAmount: units(it.price) })),
        daysUntilDue: Number(days),
      });
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (i: number, k: "description" | "quantity" | "price", v: string) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));

  return (
    <div className="dash-two" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 16, alignItems: "start" }}>
      <div className="card stack">
        <div className="h2">Invoices</div>
        {data === null ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>No invoices yet. Create one: the customer gets a page they can pay with any coin.</Empty> : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th>Invoice</th><th>Due</th><th>Status</th><th style={{ textAlign: "right" }}>Amount</th><th /></tr></thead>
              <tbody>
                {data.map((i) => (
                  <tr key={i.id}>
                    <td><div style={{ fontWeight: 500 }}>{i.number} · {i.customer.name}</div><div className="tiny muted">{i.subscriptionId ? "subscription" : `${i.items.length} item${i.items.length === 1 ? "" : "s"}`}</div></td>
                    <td className="small soft">{i.dueDate}</td>
                    <td><Badge tone={invoiceTone(i)}>{i.status === "open" && i.overdue ? "overdue" : i.status}</Badge></td>
                    <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>{usd(i.amount)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <a className="btn ghost sm" href={`/i/${i.id}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open</a>
                      {i.status === "open" && <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => call(secret, `invoices/${i.id}/void`, {}).then(load, (e: Error) => onError(e.message))}><Ban size={14} /> Void</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="h2">New invoice</div>
        <div className="grid-2">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" aria-label="Customer name" />
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" aria-label="Customer email" />
        </div>
        {items.map((it, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 64px 92px 36px", gap: 8 }}>
            <input className="input" value={it.description} onChange={(e) => set(i, "description", e.target.value)} aria-label={`Item ${i + 1}`} />
            <input className="input num" value={it.quantity} onChange={(e) => set(i, "quantity", e.target.value)} aria-label={`Quantity ${i + 1}`} />
            <input className="input num" value={it.price} onChange={(e) => set(i, "price", e.target.value)} aria-label={`Unit price ${i + 1}`} />
            <button className="icon-btn" style={{ height: 44, width: 36 }} onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove item" disabled={items.length === 1}><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="row">
          <button className="btn ghost sm" onClick={() => setItems([...items, { description: "", quantity: "1", price: "0.00" }])}><Plus size={14} /> Item</button>
          <label className="row-start small muted">Due in <input className="input num" style={{ width: 64, height: 34 }} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days until due" /> days</label>
        </div>
        <div className="divider" />
        <div className="row"><span className="muted small">Total</span><span className="amount num" style={{ fontSize: 26 }}>{usd(total)}</span></div>
        <button className="btn block" disabled={busy || !name} onClick={create}>{busy ? "Creating…" : "Create invoice"}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ subscriptions

export function SubscriptionsTab({ secret, onError }: Props) {
  const plans = useList<Plan>(secret, "plans", onError);
  const subs = useList<Subscription>(secret, "subscriptions", onError);
  const [pName, setPName] = useState("Mug of the month");
  const [pAmount, setPAmount] = useState("12.00");
  const [interval, setInterval_] = useState<Interval>("month");
  const [planId, setPlanId] = useState("");
  const [cName, setCName] = useState("Ines Duarte");
  const [cEmail, setCEmail] = useState("ines@example.com");
  const [prepaid, setPrepaid] = useState("1");
  const [last, setLast] = useState<string | null>(null);

  const act = async (f: () => Promise<unknown>) => {
    onError(null);
    try {
      await f();
      await Promise.all([plans.load(), subs.load()]);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const chosen = planId || plans.data?.[0]?.id || "";

  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="h2">Subscriptions</div>
        {subs.data === null ? <Empty>Loading…</Empty> : subs.data.length === 0 ? <Empty>No subscriptions yet. Each period Cascade issues the next invoice before it is due; customers can prepay up to 12 periods.</Empty> : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>Paid until</th><th /></tr></thead>
              <tbody>
                {subs.data.map((s) => (
                  <tr key={s.id}>
                    <td><div style={{ fontWeight: 500 }}>{s.customer.name}</div><div className="tiny muted">{s.customer.email ?? s.id}</div></td>
                    <td className="small">{s.plan.name} · {usd(s.plan.amount)}/{s.plan.interval}</td>
                    <td><Badge tone={s.status === "active" ? "ok" : s.status === "past_due" ? "bad" : s.status === "canceled" ? "neutral" : "warn"}>{s.status.replace("_", " ")}{s.cancelAtPeriodEnd ? " (ends)" : ""}</Badge></td>
                    <td className="small soft">{day(s.currentPeriodEnd)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {s.latestInvoiceId && <a className="btn ghost sm" href={`/i/${s.latestInvoiceId}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Invoice</a>}
                      {s.status !== "canceled" && <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => act(() => call(secret, `subscriptions/${s.id}/cancel`, { atPeriodEnd: s.status === "active" }))}>Cancel</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dash-two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
        <div className="card stack">
          <div className="h2">Plans</div>
          {(plans.data ?? []).map((p) => (
            <div key={p.id} className="row small"><span>{p.name}</span><span className="num soft">{usd(p.amount)} / {p.interval}</span></div>
          ))}
          <div className="divider" />
          <input className="input" value={pName} onChange={(e) => setPName(e.target.value)} aria-label="Plan name" />
          <div className="grid-2">
            <input className="input num" value={pAmount} onChange={(e) => setPAmount(e.target.value)} aria-label="Price per interval" />
            <select className="input" value={interval} onChange={(e) => setInterval_(e.target.value as Interval)} aria-label="Interval">
              {(["day", "week", "month", "year"] as const).map((i) => <option key={i} value={i}>every {i}</option>)}
            </select>
          </div>
          <button className="btn ghost" onClick={() => act(() => call(secret, "plans", { name: pName, amount: units(pAmount), interval }))}><Plus size={15} /> Add plan</button>
        </div>

        <div className="card stack">
          <div className="h2">Subscribe a customer</div>
          <select className="input" value={chosen} onChange={(e) => setPlanId(e.target.value)} aria-label="Plan" disabled={!plans.data?.length}>
            {(plans.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} · {usd(p.amount)}/{p.interval}</option>)}
          </select>
          <div className="grid-2">
            <input className="input" value={cName} onChange={(e) => setCName(e.target.value)} aria-label="Customer name" />
            <input className="input" value={cEmail} onChange={(e) => setCEmail(e.target.value)} aria-label="Customer email" />
          </div>
          <label className="row small muted">Prepay periods <input className="input num" style={{ width: 72, height: 36 }} value={prepaid} onChange={(e) => setPrepaid(e.target.value)} aria-label="Prepaid periods" /></label>
          <button className="btn" disabled={!chosen} onClick={() => act(async () => {
            const s = await call<Subscription & { latestInvoice: Invoice }>(secret, "subscriptions", { planId: chosen, customer: { name: cName, ...(cEmail ? { email: cEmail } : {}) }, prepaidPeriods: Number(prepaid) });
            setLast(s.latestInvoice.url);
          })}>Create subscription</button>
          {last && <a className="small row-start" href={last.replace(/^https?:\/\/[^/]+/, "")} target="_blank" rel="noreferrer"><ExternalLink size={14} /> First invoice, ready to send</a>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ customers

export function CustomersTab({ secret, onError }: Props) {
  const { data } = useList<CustomerSummary>(secret, "customers", onError);
  return (
    <div className="card stack">
      <div className="h2">Customers</div>
      {data === null ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>Customers appear here once you invoice or subscribe them.</Empty> : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Customer</th><th>Invoices</th><th>Subscriptions</th><th style={{ textAlign: "right" }}>Outstanding</th><th style={{ textAlign: "right" }}>Paid</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.email ?? c.name}>
                  <td><div style={{ fontWeight: 500 }}>{c.name}</div><div className="tiny muted">{c.email ?? "no email"} · last activity {day(c.lastActivity)}</div></td>
                  <td className="num">{c.invoices}</td>
                  <td className="num">{c.subscriptions}</td>
                  <td className="num" style={{ textAlign: "right" }}>{usd(c.outstanding)}</td>
                  <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>{usd(c.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
