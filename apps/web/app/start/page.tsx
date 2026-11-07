"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Building2, Check, Copy, FlaskConical, Loader2 } from "lucide-react";
import { API } from "../../lib/api";
import { Nav } from "../components/ui";

type Sandbox = { merchant: { name: string; account: string }; secretKey: string; accountKey: string; network: string };

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

function Secret({ label, value, note }: { label: string; value: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="tiny muted">{label}</div>
      <div className="well row" style={{ gap: 8 }}>
        <span className="mono" style={{ fontSize: 12 }}>{value}</span>
        <button className="icon-btn" aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {note && <div className="tiny muted">{note}</div>}
    </div>
  );
}

function SandboxCard() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Sandbox | null>(null);

  useEffect(() => {
    fetch(`${API}/api/sandbox`).then((r) => r.json()).then((j: { available: boolean }) => setAvailable(j.available), () => setAvailable(false));
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setDone(await post<Sandbox>("/api/sandbox/merchant", { name: name || "My test business" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const open = (path: string) => {
    try {
      sessionStorage.setItem("cascade_dashboard_key", done!.secretKey);
    } catch {
      /* private mode: the dashboard will ask for the key */
    }
    window.location.href = path;
  };

  return (
    <div className="card stack-lg">
      <div className="row-start"><span className="icon-btn" style={{ cursor: "default" }}><FlaskConical size={18} /></span><div><div className="h2">Sandbox</div><div className="small muted">Instant and free. No wallet, no paperwork.</div></div></div>
      {!done ? (
        <>
          <ul className="small soft" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            <li>A real NEAR testnet account for your business, registered with Cascade</li>
            <li>Secret keys, dashboard, payment links, invoices, subscriptions, point of sale</li>
            <li>Customers&apos; payments are simulated; contracts and receipts are real</li>
          </ul>
          <input className="input" placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Business name" maxLength={80} />
          <button className="btn block" onClick={create} disabled={busy || available === false}>
            {busy ? <><Loader2 size={16} className="spin" /> Creating your account on testnet…</> : <>Create a sandbox account <ArrowRight size={16} /></>}
          </button>
          {available === false && <div className="small muted">The sandbox runs on the testnet demo deployment.</div>}
          {error && <div className="small error">{error}</div>}
        </>
      ) : (
        <>
          <div className="row-start" style={{ color: "var(--ok)", fontWeight: 600 }}><Check size={18} /> {done.merchant.name} is ready on NEAR {done.network}</div>
          <Secret label="Secret key (server side only)" value={done.secretKey} note="Shown once. Use it with the SDK, the API or the dashboard." />
          <Secret label="Your NEAR account" value={done.merchant.account} />
          <Secret label="Account key (testnet only)" value={done.accountKey} note="This account is yours. Keep the key to sign as the merchant, e.g. to change payouts." />
          <div className="grid-2">
            <button className="btn" onClick={() => open("/dashboard")}>Open dashboard</button>
            <button className="btn ghost" onClick={() => open("/pos")}>Point of sale</button>
          </div>
        </>
      )}
    </div>
  );
}

function LiveCard() {
  const [f, setF] = useState({ company: "", website: "", email: "", country: "", monthlyVolume: "", useCase: "", nearAccount: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const missing = [
    f.company.trim().length < 2 && "company",
    !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim()) && "a work email",
    f.useCase.trim().length < 10 && "what you will use Cascade for",
  ].filter(Boolean) as string[];

  async function submit() {
    if (missing.length) {
      setError(`Please add ${missing.join(", ")}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSent((await post<{ id: string }>("/api/apply", f)).id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack-lg">
      <div className="row-start"><span className="icon-btn" style={{ cursor: "default" }}><Building2 size={18} /></span><div><div className="h2">Go live</div><div className="small muted">Real payments on mainnet, settled in USDC.</div></div></div>
      {sent ? (
        <div className="stack">
          <div className="row-start" style={{ color: "var(--ok)", fontWeight: 600 }}><Check size={18} /> Application received</div>
          <p className="small soft" style={{ margin: 0 }}>Reference <span className="mono">{sent}</span>. We review every business before issuing live keys, and reply by email. Meanwhile, build against the sandbox: the API is the same.</p>
        </div>
      ) : (
        <>
          <div className="grid-2">
            <input className="input" placeholder="Company" value={f.company} onChange={set("company")} aria-label="Company" />
            <input className="input" placeholder="Work email" type="email" value={f.email} onChange={set("email")} aria-label="Work email" />
            <input className="input" placeholder="Website" value={f.website} onChange={set("website")} aria-label="Website" />
            <input className="input" placeholder="Country" value={f.country} onChange={set("country")} aria-label="Country" />
          </div>
          <select className="input" value={f.monthlyVolume} onChange={set("monthlyVolume")} aria-label="Expected monthly volume">
            <option value="">Expected monthly volume</option>
            <option>Under $10k</option><option>$10k to $100k</option><option>$100k to $1M</option><option>Over $1M</option>
          </select>
          <textarea className="input" style={{ height: 96, paddingTop: 12 }} placeholder="What will you use Cascade for? (checkout, invoices, payouts, agents…)" value={f.useCase} onChange={set("useCase")} aria-label="Use case" />
          <input className="input" placeholder="NEAR account that receives payments (optional)" value={f.nearAccount} onChange={set("nearAccount")} aria-label="NEAR account" />
          <button className="btn block ghost" onClick={submit} disabled={busy}>{busy ? <Loader2 size={16} className="spin" /> : null} Apply for live access</button>
          {error && <div className="small error">{error}</div>}
          <div className="tiny muted">Already have a NEAR account? Developers can onboard with a signed message today: see the developer guide.</div>
        </>
      )}
    </div>
  );
}

export default function Start() {
  return (
    <div className="page">
      <Nav />
      <main className="container stack-lg" style={{ padding: "56px 24px 72px" }}>
        <div className="stack" style={{ maxWidth: 720 }}>
          <div className="eyebrow">Get started</div>
          <h1 className="h1">Accept any coin in minutes.</h1>
          <p className="soft" style={{ margin: 0 }}>Try everything in the sandbox right now, then apply for live access. Same API, same dashboard, same receipts.</p>
        </div>
        <section className="grid-2" style={{ gap: 16, alignItems: "start" }}>
          <SandboxCard />
          <LiveCard />
        </section>
      </main>
    </div>
  );
}
