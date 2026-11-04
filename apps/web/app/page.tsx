import Link from "next/link";
import { ArrowUpRight, Bot, Building2, Coins, FileCheck2, QrCode, Repeat2, Split, Undo2, Zap } from "lucide-react";
import { DotOrb } from "./components/DotOrb";
import { DemoBanner, Nav } from "./components/ui";

const steps = [
  { n: "01", title: "They pick a coin", body: "ETH on Base, SOL, BTC, USDC on Arbitrum… whatever they already hold, from the wallet they already use. Or scan a QR code." },
  { n: "02", title: "NEAR Intents converts it", body: "Solvers swap and bridge in one step. No bridges to pick, no gas tokens to buy. If anything fails, the payer is refunded automatically." },
  { n: "03", title: "You receive exact dollars", body: "USDC lands in your NEAR account or your team's DAO, with an on-chain receipt and a signed webhook for your server." },
];

const features = [
  { icon: Zap, title: "One-button checkout", body: "Drop in openCheckout() or share a link. Hosted page, QR codes, wallet payments." },
  { icon: Bot, title: "AI agents pay too", body: "Protect any API with x402: agents get HTTP 402, pay with any coin, and retry." },
  { icon: Split, title: "Revenue splits", body: "80% shop, 15% artist, 5% community DAO, split by the contract the moment money arrives." },
  { icon: Undo2, title: "Refunds that work", body: "Send money back in the coin and on the chain the customer paid with." },
  { icon: FileCheck2, title: "Verifiable receipts", body: "Every payment has a public receipt anyone can check against the chain." },
  { icon: Building2, title: "Team payroll", body: "Pay people on any chain after your Sputnik DAO approves. Approvers pay no fees." },
];

const code = `import { Cascade } from "@cascade/sdk/server";
const cascade = new Cascade({ apiKey: process.env.CASCADE_SECRET_KEY });

const session = await cascade.checkout.create({
  amount: "25.00",
  description: "Stoneware mug",
  reference: order.id,
});
// browser: openCheckout({ sessionUrl: session.url })
// webhook: verifyWebhook(body, header, secret) -> ship it`;

export default function Home() {
  return (
    <div className="page">
      <DemoBanner />
      <Nav />

      <section className="container" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,0.9fr)", alignItems: "center", gap: 24, padding: "72px 24px 40px" }}>
        <div className="stack-lg rise">
          <span className="pill accent"><Coins size={14} /> Checkout for NEAR Intents</span>
          <h1 className="display">Get paid in any coin.<br /><span style={{ color: "var(--muted)" }}>Receive dollars.</span></h1>
          <p className="soft" style={{ fontSize: 18, maxWidth: 520, margin: "18px 0 0" }}>
            Your customers pay with whatever they hold, on any chain. You receive the exact amount in USDC on NEAR, in your own account. Cascade never holds your money.
          </p>
          <div className="row-start" style={{ flexWrap: "wrap", marginTop: 28 }}>
            <Link className="btn" href="/shop">Try the demo shop <ArrowUpRight size={16} /></Link>
            <a className="btn ghost" href="#developers">For developers</a>
          </div>
          <div className="row-start tiny muted" style={{ flexWrap: "wrap", gap: 16, marginTop: 28 }}>
            <span className="row-start" style={{ gap: 6 }}><QrCode size={14} /> 200+ coins, 35+ chains</span>
            <span className="row-start" style={{ gap: 6 }}><Repeat2 size={14} /> No gas for anyone</span>
            <span className="row-start" style={{ gap: 6 }}><FileCheck2 size={14} /> Receipts on-chain</span>
          </div>
        </div>
        <div style={{ display: "grid", placeItems: "center" }} className="hide-mobile">
          <DotOrb size={440} />
        </div>
      </section>

      <section id="how" className="container" style={{ padding: "48px 24px" }}>
        <div className="eyebrow">How it works</div>
        <h2 className="h1" style={{ marginTop: 10, maxWidth: 640 }}>Three steps, about thirty seconds.</h2>
        <div className="grid-3" style={{ marginTop: 28 }}>
          {steps.map((s) => (
            <div key={s.n} className="card stack">
              <div className="mono muted">{s.n}</div>
              <div className="h2">{s.title}</div>
              <p className="soft small" style={{ margin: 0 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container" style={{ padding: "24px 24px 48px" }}>
        <div className="grid-3">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="card tight stack">
              <span className="icon-btn" style={{ cursor: "default" }}><Icon size={18} /></span>
              <div style={{ fontWeight: 600 }}>{title}</div>
              <p className="muted small" style={{ margin: 0 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="developers" className="container" style={{ padding: "48px 24px" }}>
        <div className="card" style={{ display: "grid", gridTemplateColumns: "minmax(0,0.9fr) minmax(0,1.1fr)", gap: 32, alignItems: "center" }}>
          <div className="stack-lg">
            <div className="eyebrow">Developers</div>
            <h2 className="h1">Ten lines to accept any coin.</h2>
            <p className="soft" style={{ margin: 0 }}>A dependency-free SDK: checkout sessions, a pay button, signed webhooks, refunds and x402 for agents. Settlement goes through NEAR Intents; your users never pay gas.</p>
            <div className="row-start" style={{ flexWrap: "wrap" }}>
              <a className="btn light sm" href="https://github.com/timioni001/cascade" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={14} /></a>
              <Link className="btn ghost sm" href="/dashboard">Merchant dashboard</Link>
            </div>
          </div>
          <pre className="mono" style={{ margin: 0, background: "var(--card-2)", border: "1px solid var(--line)", borderRadius: "var(--r-lg)", padding: 20, whiteSpace: "pre-wrap", wordBreak: "normal", lineHeight: 1.7, color: "var(--ink-2)" }}>{code}</pre>
        </div>
      </section>

      <footer className="container row tiny muted" style={{ padding: "32px 24px 48px", borderTop: "1px solid var(--line)" }}>
        <span>© {new Date().getFullYear()} Cascade</span>
        <span>Settles through NEAR Intents</span>
      </footer>
    </div>
  );
}
