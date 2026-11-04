"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Bot, ExternalLink, Lock, Send } from "lucide-react";
import { Badge, chainName, usd, type Tone } from "../components/ui";
import { call } from "./api";

type Props = { secret: string; onError: (m: string | null) => void };
/** Mirrors of the contract's views (contracts/app/src/vault.rs). */
type Escrow = {
  id: number; payee: string; payer: string; arbiter: string | null; total: string; refund_after_ms: number;
  status: "AwaitingFunds" | "Funded" | "Closed" | "Cancelled"; milestones: { title: string; amount: string; status: string }[];
};
type Allowance = {
  owner: string; agent: string; balance: string; day: number; spent_today: string; total_spent: string; payments: number; revoked: boolean; purpose: string;
  policy: { per_payment_max: string; daily_max: string; expires_at_ms: number; payees: string[] };
};
type Payout = {
  id: number; title: string; createdAt: string; lines: number; total: string; status: string; dao: boolean;
  recipients: { name: string; chain: string; address: string; amount: string }[];
};

function useList<T>(secret: string, path: string, onError: Props["onError"]) {
  const [data, setData] = useState<T[] | null>(null);
  const load = useCallback(() => call<{ data: T[] }>(secret, path).then((r) => setData(r.data), (e: Error) => onError(e.message)), [secret, path, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, load };
}

const when = (ms: number | string) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const short = (a: string) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);

function Empty({ icon: Icon, title, children }: { icon: typeof Send; title: string; children: React.ReactNode }) {
  return (
    <div className="stack" style={{ padding: "28px 0", textAlign: "center", justifyItems: "center", display: "grid" }}>
      <span className="icon-btn" style={{ cursor: "default", margin: "0 auto" }}><Icon size={18} /></span>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div className="small muted" style={{ maxWidth: 460, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

const batchTone = (s: string): Tone => (s === "Done" ? "ok" : s === "PartlyRefunded" || s === "Refunded" ? "warn" : s === "Cancelled" ? "neutral" : "neutral");

// ------------------------------------------------------------ payouts

export function PayoutsTab({ secret, onError }: Props) {
  const { data } = useList<Payout>(secret, "merchant/payouts", onError);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="card stack">
      <div className="row"><div className="h2">Payouts</div><span className="small muted">Contractors, creators, refunds and payroll, to any chain</span></div>
      {data === null ? <div className="muted small">Loading…</div> : data.length === 0 ? (
        <Empty icon={Send} title="No payouts yet">
          Pay up to 50 people in one batch, each on their own chain (USDC on Solana, Base, NEAR…). The batch is locked on-chain before you fund it; a team approves through its DAO. Create one with the SDK or from your NEAR wallet.
        </Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Batch</th><th>Recipients</th><th>Created</th><th>Status</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
            <tbody>
              {data.map((b) => (
                <Fragment key={b.id}>
                  <tr onClick={() => setOpen(open === b.id ? null : b.id)} style={{ cursor: "pointer" }}>
                    <td><div style={{ fontWeight: 500 }}>{b.title}</div><div className="tiny muted">#{b.id}{b.dao ? " · approved by DAO vote" : ""}</div></td>
                    <td className="small">{b.lines} · {[...new Set(b.recipients.map((r) => chainName(r.chain)))].join(", ")}</td>
                    <td className="small soft">{when(b.createdAt)}</td>
                    <td><Badge tone={batchTone(b.status)}>{b.status.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}</Badge></td>
                    <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>{usd(b.total)}</td>
                  </tr>
                  {open === b.id && b.recipients.map((r, i) => (
                    <tr key={`${b.id}-${i}`} className="small">
                      <td style={{ paddingLeft: 28 }}>{r.name}</td>
                      <td className="soft" colSpan={3}>{chainName(r.chain)} · <span className="mono">{short(r.address)}</span></td>
                      <td className="num" style={{ textAlign: "right" }}>{usd(r.amount)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ escrow

const msTone = (s: string): Tone => (s === "Released" ? "ok" : s === "Refunded" ? "neutral" : s === "Pending" ? "warn" : "neutral");

export function EscrowTab({ secret, account, onError }: Props & { account: string }) {
  const { data } = useList<Escrow>(secret, "merchant/escrows", onError);
  const [links, setLinks] = useState<Record<number, string>>({});

  async function fundingLink(e: Escrow) {
    onError(null);
    try {
      const s = await call<{ url: string }>(secret, "checkout/sessions", { amount: e.total, description: `Escrow #${e.id}: ${e.milestones.map((m) => m.title).join(", ")}`.slice(0, 300), escrowId: e.id, expiresInMinutes: 1440 });
      setLinks({ ...links, [e.id]: s.url.replace(/^https?:\/\/[^/]+/, "") });
    } catch (err) {
      onError((err as Error).message);
    }
  }

  if (data === null) return <div className="card muted small">Loading…</div>;
  if (data.length === 0) {
    return (
      <div className="card">
        <Empty icon={Lock} title="No escrows yet">
          For work paid in milestones: the client funds the escrow from any chain, the contract holds the money, and each milestone is released to you when the client approves it. Refunds can only go back to the client.
        </Empty>
      </div>
    );
  }
  return (
    <div className="stack-lg">
      {data.map((e) => {
        const released = e.milestones.filter((m) => m.status === "Released").reduce((t, m) => t + BigInt(m.amount), 0n);
        const held = e.status === "Funded" ? e.milestones.filter((m) => m.status === "Pending" || m.status === "Releasing" || m.status === "Refunding").reduce((t, m) => t + BigInt(m.amount), 0n) : 0n;
        const youArePayee = e.payee === account;
        return (
          <div key={e.id} className="card stack">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div>
                <div className="h2">Escrow #{e.id}</div>
                <div className="small muted">{youArePayee ? `From ${e.payer}` : `To ${e.payee}`}{e.arbiter ? ` · arbiter ${e.arbiter}` : ""} · refundable to the client after {when(e.refund_after_ms)}</div>
              </div>
              <Badge tone={e.status === "Funded" ? "warn" : e.status === "Closed" ? "ok" : "neutral"}>{e.status === "AwaitingFunds" ? "awaiting funds" : e.status.toLowerCase()}</Badge>
            </div>
            <div className="grid-3">
              <div className="well"><div className="tiny muted">Total</div><div className="num" style={{ fontWeight: 600 }}>{usd(e.total)}</div></div>
              <div className="well"><div className="tiny muted">Held by the contract</div><div className="num" style={{ fontWeight: 600 }}>{usd(held)}</div></div>
              <div className="well"><div className="tiny muted">Released to {youArePayee ? "you" : "payee"}</div><div className="num" style={{ fontWeight: 600 }}>{usd(released)}</div></div>
            </div>
            <table className="table">
              <tbody>
                {e.milestones.map((m, i) => (
                  <tr key={i}><td>{i + 1}. {m.title}</td><td><Badge tone={msTone(m.status)}>{m.status.toLowerCase()}</Badge></td><td className="num" style={{ textAlign: "right" }}>{usd(m.amount)}</td></tr>
                ))}
              </tbody>
            </table>
            {e.status === "AwaitingFunds" && youArePayee && (
              links[e.id]
                ? <a className="btn ghost sm" href={links[e.id]} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Funding link for the client</a>
                : <button className="btn sm" onClick={() => fundingLink(e)}>Create a funding link (any coin, any chain)</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ agent budgets

export function AgentsTab({ secret, onError }: Props) {
  const { data } = useList<Allowance>(secret, "merchant/agents", onError);
  const today = Math.floor(Date.now() / 86_400_000);
  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="row"><div className="h2">Agent budgets</div><Bot size={18} className="muted" /></div>
        <p className="small soft" style={{ margin: 0 }}>
          Give an AI agent money to spend on your behalf, with limits the NEAR contract enforces: per payment, per day, an expiry and allowed recipients. It pays x402 APIs without holding any NEAR, and every payment&apos;s receipt shows your authorization.
        </p>
        {data === null ? <div className="muted small">Loading…</div> : data.length === 0 ? (
          <Empty icon={Bot} title="No agents yet">Set a budget with <span className="mono">set_allowance</span> from your NEAR account, then connect the agent through the Cascade MCP server.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th>Agent</th><th>Limits</th><th>Today</th><th>Status</th><th style={{ textAlign: "right" }}>Balance</th></tr></thead>
              <tbody>
                {data.map((a) => {
                  const spentToday = a.day === today ? BigInt(a.spent_today) : 0n;
                  const active = !a.revoked && Date.now() < a.policy.expires_at_ms;
                  return (
                    <tr key={a.agent}>
                      <td><div style={{ fontWeight: 500 }}>{a.agent}</div>{a.purpose && <div className="tiny muted">“{a.purpose}”</div>}</td>
                      <td className="small">{usd(a.policy.per_payment_max)} per payment · {usd(a.policy.daily_max)}/day<div className="tiny muted">until {when(a.policy.expires_at_ms)} · {a.policy.payees.length ? `${a.policy.payees.length} allowed recipient${a.policy.payees.length === 1 ? "" : "s"}` : "any recipient"}</div></td>
                      <td className="small">
                        <div className="num">{usd(spentToday)} of {usd(a.policy.daily_max)}</div>
                        <div style={{ height: 4, borderRadius: 999, background: "var(--card-2)", marginTop: 6, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${Math.min(100, Number((spentToday * 100n) / BigInt(a.policy.daily_max)))}%`, background: "var(--ink)" }} />
                        </div>
                      </td>
                      <td><Badge tone={active ? "ok" : "neutral"}>{a.revoked ? "revoked" : active ? "active" : "expired"}</Badge><div className="tiny muted" style={{ marginTop: 4 }}>{a.payments} payment{a.payments === 1 ? "" : "s"} · {usd(a.total_spent)} total</div></td>
                      <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>{usd(a.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card stack">
        <div className="h2">Connect an assistant</div>
        <p className="small soft" style={{ margin: 0 }}>The Cascade MCP server gives Claude, Cursor or any MCP client two tools: <span className="mono">wallet_status</span> and <span className="mono">paid_fetch</span>, which pays x402 APIs from this budget.</p>
        <pre className="mono tiny" style={{ margin: 0, background: "var(--card-2)", borderRadius: "var(--r-md)", padding: 14, whiteSpace: "pre-wrap" }}>{`claude mcp add cascade \\
  --env CASCADE_URL=${typeof window !== "undefined" ? window.location.origin : "https://…"} \\
  --env CASCADE_AGENT_ACCOUNT=<agent> --env CASCADE_AGENT_OWNER=<you> \\
  --env CASCADE_AGENT_KEY=ed25519:… --env CASCADE_APP_ID=<contract> \\
  -- npx tsx packages/mcp/src/main.ts`}</pre>
      </div>
    </div>
  );
}
