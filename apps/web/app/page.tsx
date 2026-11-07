import Link from "next/link";
import {
  ArrowRight, ArrowUpRight, Bot, Building2, Check, Coins, FileCheck2, Lock, Plug, QrCode, Repeat2, ScrollText, ShieldCheck, Split, Store, Undo2, Users, Zap,
} from "lucide-react";
import { DotOrb } from "./components/DotOrb";
import { CoinMark, Mark, Nav } from "./components/ui";

const steps = [
  { n: "01", title: "They pick a coin", body: "ETH on Base, SOL, BTC, USDC on Arbitrum… whatever they already hold, from the wallet they already use, or by scanning a QR code." },
  { n: "02", title: "NEAR Intents converts it", body: "Solvers swap and bridge in one step. No bridges to pick, no gas tokens to buy. If anything fails, the payer is refunded automatically." },
  { n: "03", title: "You receive exact dollars", body: "USDC lands in your own account, your team's DAO, or the chain you choose, with an on-chain receipt and a signed webhook." },
];

const products: { group: string; blurb: string; items: { icon: typeof Zap; title: string; body: string }[] }[] = [
  {
    group: "Get paid",
    blurb: "Every way a customer pays you, in any coin.",
    items: [
      { icon: Zap, title: "Checkout", body: "A pay button or a link. Hosted page, QR codes, wallet payments, signed webhooks." },
      { icon: Store, title: "Point of sale", body: "Type an amount on your phone; the customer scans and pays. Green when the money lands." },
      { icon: ScrollText, title: "Invoices and subscriptions", body: "Numbered invoices, due dates and reminders. Plans billed every period, prepaid months." },
    ],
  },
  {
    group: "Pay out",
    blurb: "Money out, on everyone's own chain.",
    items: [
      { icon: Building2, title: "Payouts and payroll", body: "Up to 50 people per batch, each on their chain, after your DAO approves. No fees for approvers." },
      { icon: Lock, title: "Milestone escrow", body: "The contract holds the client's money and releases each milestone when they approve it." },
      { icon: Split, title: "Revenue splits", body: "80% shop, 15% artist, 5% community: divided by the contract the moment money arrives." },
    ],
  },
  {
    group: "Automate",
    blurb: "For software and AI that pays and gets paid.",
    items: [
      { icon: Bot, title: "AI agents with budgets", body: "Agents pay APIs over x402 within limits the contract enforces; every receipt shows who authorized them." },
      { icon: Plug, title: "MCP server", body: "Run your account from Claude, Cursor or any MCP client: invoices, links, payments, reports." },
      { icon: Undo2, title: "Refunds and receipts", body: "Refund in the customer's own coin. Every payment has a public receipt anyone can verify." },
    ],
  },
];

const coins: [string, string][] = [
  ["ETH", "eth"], ["SOL", "sol"], ["BTC", "btc"], ["USDC", "base"], ["USDT", "tron"], ["ARB", "arb"], ["BASE", "base"], ["TON", "ton"],
  ["DOGE", "doge"], ["XRP", "xrp"], ["BNB", "bsc"], ["SUI", "sui"], ["ZEC", "zec"], ["NEAR", "near"], ["POL", "pol"], ["OP", "op"],
];

const faqs: [string, string][] = [
  ["Does Cascade hold my money?", "No. NEAR Intents delivers each payment straight to your account (or your team's DAO). The Cascade contract only holds money you put in escrow, a split or a payout batch, and it can only send it where you fixed in advance."],
  ["Which coins can customers pay with?", "Over 200 assets on more than 35 chains: ETH, SOL, BTC, stablecoins on every major chain, and more. You always receive US dollars as USDC."],
  ["What if a payment goes wrong?", "If a swap cannot complete, NEAR Intents refunds the customer automatically on their own chain. You can also refund any paid order in the customer's coin from the dashboard."],
  ["Do my customers need a NEAR wallet or gas?", "No. They pay from the wallet they already have. Merchants and their teams don't pay network fees either: Cascade covers them."],
  ["How do I start?", "Create a sandbox account in seconds at /start and integrate with test keys. When you are ready, apply for live access: same API, same dashboard."],
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

/**
 * Coins sit on and just outside the rim of the sphere, placed by angle so they
 * stay on the circle at any size. `a`: degrees clockwise from 3 o'clock;
 * `r`: distance from the centre as a fraction of the half-width (the dots end at 0.84).
 */
const rimCoins: { c: string; t: string; a: number; r: number }[] = [
  { c: "btc", t: "BTC", a: -98, r: 0.9 },
  { c: "eth", t: "ETH", a: -42, r: 0.94 },
  { c: "sol", t: "SOL", a: 8, r: 0.96 },
  { c: "usdc", t: "USDC", a: 52, r: 0.9 },
  { c: "usdt", t: "USDT", a: 104, r: 0.92 },
  { c: "xrp", t: "XRP", a: 148, r: 0.94 },
  { c: "bnb", t: "BNB", a: 192, r: 0.96 },
  { c: "doge", t: "DOGE", a: 236, r: 0.92 },
];
const at = (a: number, r: number) => ({ left: `${50 + 50 * r * Math.cos((a * Math.PI) / 180)}%`, top: `${50 + 50 * r * Math.sin((a * Math.PI) / 180)}%` });

/**
 * The hero: a sphere of dots with the coins people pay with around it, one
 * payment's route drawn across it, and the receipt underneath. Monochrome on
 * purpose, so colour only ever means status.
 */
function HeroPreview() {
  return (
    <div className="hero-preview" aria-hidden="true">
      <div className="globe">
        <DotOrb size={460} points={2600} />
        <svg className="globe-route" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M28 38 Q 50 14 72 32" />
          <circle cx="28" cy="38" r="1.6" />
          <circle cx="72" cy="32" r="1.6" />
        </svg>
        <span className="route-dot" style={{ left: "28%", top: "38%" }} />
        <span className="route-dot end" style={{ left: "72%", top: "32%" }} />
        {rimCoins.map(({ c, t, a, r }, i) => (
          <span key={c} className="coin-pill" style={{ ...at(a, r), animationDelay: `${(i % 4) * 0.9}s` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/coins/${c}.svg`} alt="" width={18} height={18} />
            {t}
          </span>
        ))}
        <div className="globe-pay">
          <span className="muted">ETH on Base</span>
          <span className="globe-arrow">→</span>
          <strong>$25.00 USDC</strong>
          <span className="muted">on NEAR</span>
        </div>
      </div>
      <div className="globe-receipt">
        <span className="stub-perf" />
        <FileCheck2 size={14} />
        <span>Receipt #128 recorded on NEAR</span>
        <Check size={13} />
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div className="page">
      <Nav />

      <section className="container hero">
        <div className="stack-lg rise">
          <span className="pill accent"><Coins size={14} /> Payments infrastructure on NEAR</span>
          <h1 className="display">Get paid in any coin.<br /><span style={{ color: "var(--muted)" }}>Receive dollars.</span></h1>
          <p className="soft lead">
            Checkout, invoices, point of sale, payouts and AI agent payments. Customers pay with whatever they hold, on any chain; you receive the exact amount in USDC, in your own account.
          </p>
          <div className="row-start" style={{ flexWrap: "wrap", marginTop: 8 }}>
            <Link className="btn" href="/start">Start free in the sandbox <ArrowRight size={16} /></Link>
            <Link className="btn ghost" href="/shop">See the demo shop</Link>
          </div>
          <div className="row-start tiny muted" style={{ flexWrap: "wrap", gap: 16 }}>
            <span className="row-start" style={{ gap: 6 }}><QrCode size={14} /> 200+ coins, 35+ chains</span>
            <span className="row-start" style={{ gap: 6 }}><Repeat2 size={14} /> No gas for anyone</span>
            <span className="row-start" style={{ gap: 6 }}><ShieldCheck size={14} /> Non-custodial</span>
          </div>
        </div>
        <HeroPreview />
      </section>

      <section className="coin-strip" aria-label="Coins your customers can pay with">
        <div className="tiny muted" style={{ textAlign: "center", marginBottom: 14 }}>Your customers pay with</div>
        <div className="marquee">
          <div className="marquee-track">
            {[...coins, ...coins].map(([s, c], i) => (
              <span key={i} className="pill" style={{ gap: 8, height: 36, paddingLeft: 6 }} aria-hidden={i >= coins.length}><CoinMark symbol={s} chain={c} size={24} /> {s}</span>
            ))}
          </div>
        </div>
      </section>

      <section id="how" className="container section">
        <div className="eyebrow">How it works</div>
        <h2 className="h1 section-title">Three steps, about thirty seconds.</h2>
        <div className="grid-3">
          {steps.map((s) => (
            <div key={s.n} className="card stack">
              <div className="mono muted">{s.n}</div>
              <div className="h2">{s.title}</div>
              <p className="soft small" style={{ margin: 0 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="products" className="container section">
        <div className="eyebrow">Products</div>
        <h2 className="h1 section-title">Everything a business needs to use onchain money.</h2>
        <div className="stack-lg">
          {products.map((g) => (
            <div key={g.group} className="product-group">
              <div className="stack" style={{ gap: 6 }}>
                <div className="h2">{g.group}</div>
                <p className="small muted" style={{ margin: 0 }}>{g.blurb}</p>
              </div>
              <div className="grid-3">
                {g.items.map(({ icon: Icon, title, body }) => (
                  <div key={title} className="card tight stack feature">
                    <span className="icon-btn" style={{ cursor: "default" }}><Icon size={18} /></span>
                    <div style={{ fontWeight: 600 }}>{title}</div>
                    <p className="muted small" style={{ margin: 0 }}>{body}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="developers" className="container section">
        <div className="card dev-card">
          <div className="stack-lg">
            <div className="eyebrow">Developers</div>
            <h2 className="h1">Ten lines to accept any coin.</h2>
            <p className="soft" style={{ margin: 0 }}>A dependency-free SDK and REST API: sessions, a pay button, signed webhooks, invoices, refunds, x402 for agents and an MCP server. Same keys work in the sandbox and live.</p>
            <div className="row-start" style={{ flexWrap: "wrap" }}>
              <Link className="btn sm" href="/developers">Read the docs</Link>
              <a className="btn ghost sm" href="https://github.com/timioni001/cascade" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={14} /></a>
            </div>
          </div>
          <pre className="mono code-block">{code}</pre>
        </div>
      </section>

      <section id="pricing" className="container section">
        <div className="eyebrow">Pricing</div>
        <h2 className="h1 section-title">Simple, shown before anyone pays.</h2>
        <div className="grid-3">
          {[
            { t: "Sandbox", p: "Free", d: "Every product, test keys, real testnet contracts.", f: ["Instant account", "Dashboard and point of sale", "Webhooks and receipts"] },
            { t: "Live", p: "0.5%", d: "Per payment, paid by the customer on top of your price. You receive the exact amount, with no monthly fee and nothing per transaction.", f: ["Cards cost about 2.9% + $0.30", "No gas for you or your team", "Settles in USDC"] },
            { t: "Scale", p: "Talk to us", d: "Volume pricing, private payments and dedicated support.", f: ["Custom fee", "Confidential payments", "Priority review"] },
          ].map((x, i) => (
            <div key={x.t} className="card stack-lg" style={i === 1 ? { borderColor: "var(--ink)" } : undefined}>
              <div className="stack" style={{ gap: 4 }}><div className="small muted">{x.t}</div><div className="h1">{x.p}</div><p className="small soft" style={{ margin: 0 }}>{x.d}</p></div>
              <div className="stack" style={{ gap: 8 }}>{x.f.map((f) => <div key={f} className="row-start small" style={{ gap: 8 }}><Check size={15} /> {f}</div>)}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="faq" className="container section" style={{ maxWidth: 860 }}>
        <div className="eyebrow">Questions</div>
        <h2 className="h1 section-title">Good to know.</h2>
        <div className="faq">
          {faqs.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p className="soft small">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="container section">
        <div className="cta-band">
          <div className="stack" style={{ gap: 8 }}>
            <h2 className="h1" style={{ color: "inherit" }}>Start accepting any coin today.</h2>
            <p style={{ margin: 0, opacity: 0.75 }}>A sandbox account takes ten seconds. No wallet, no paperwork.</p>
          </div>
          <div className="row-start" style={{ flexWrap: "wrap" }}>
            <Link className="btn cta-primary" href="/start">Start free <ArrowRight size={16} /></Link>
            <Link className="btn cta-ghost" href="/start">Apply for live access</Link>
          </div>
        </div>
      </section>

      <footer className="container footer">
        <div className="stack" style={{ gap: 10, maxWidth: 280 }}>
          <span className="brand"><span className="brand-mark"><Mark /></span>Cascade</span>
          <p className="small muted" style={{ margin: 0 }}>Payments infrastructure on NEAR. Get paid in any coin, receive dollars.</p>
        </div>
        {[
          { h: "Products", l: [["Checkout", "/#products"], ["Point of sale", "/pos"], ["Invoices", "/#products"], ["Payouts", "/#products"], ["Agents", "/#products"]] },
          { h: "Developers", l: [["Documentation", "/developers"], ["Sandbox", "/start"], ["GitHub", "https://github.com/timioni001/cascade"]] },
          { h: "Try it", l: [["Demo shop", "/shop"], ["Dashboard", "/dashboard"], ["Go live", "/start"]] },
        ].map((c) => (
          <div key={c.h} className="stack" style={{ gap: 8 }}>
            <div className="small" style={{ fontWeight: 600 }}>{c.h}</div>
            {c.l.map(([t, h]) => <a key={t} className="small muted footer-link" href={h}>{t}</a>)}
          </div>
        ))}
        <div className="footer-bottom tiny muted"><span>© {new Date().getFullYear()} Cascade</span><span className="row-start" style={{ gap: 6 }}><Users size={13} /> Settles through NEAR Intents</span></div>
      </footer>
    </div>
  );
}
