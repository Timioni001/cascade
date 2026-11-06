import { ArrowUpRight } from "lucide-react";
import { DemoBanner, Nav } from "../components/ui";

const blocks: { title: string; body: string; code: string }[] = [
  {
    title: "1. Create a checkout session (server)",
    body: "Your secret key stays on your server. Amounts are in dollars; the customer pays in any coin and you receive exactly this amount.",
    code: `import { Cascade } from "@cascade/sdk/server";
const cascade = new Cascade({ apiKey: process.env.CASCADE_SECRET_KEY!, baseUrl: "https://<your-cascade-host>" });

const session = await cascade.checkout.create(
  { amount: "25.00", description: "Stoneware mug", reference: order.id },
  { idempotencyKey: order.id },
);`,
  },
  {
    title: "2. Open the checkout (browser)",
    body: "A modal on your page, or redirect to session.url. Wallet payments, QR codes and deposit addresses are handled for you.",
    code: `import { openCheckout } from "@cascade/sdk/browser";
openCheckout({ sessionUrl: session.url, onPaid: () => showThanks() });`,
  },
  {
    title: "3. Fulfil from the signed webhook",
    body: "Trust the webhook, never the browser. Every event is HMAC-signed with a timestamp.",
    code: `import { verifyWebhook } from "@cascade/sdk/webhooks";
const event = await verifyWebhook(rawBody, req.headers["cascade-signature"], process.env.CASCADE_WEBHOOK_SECRET!);
if (event.type === "checkout.session.completed") ship(event.data.session.reference);`,
  },
  {
    title: "Invoices, subscriptions, payouts",
    body: "Hosted invoices with line items, plans billed every period, prepaid periods, customers.",
    code: `const inv = await cascade.invoices.create({ customer: { name: "Fieldwork Café" }, items: [{ description: "Mug", quantity: 24, unitAmount: "18.00" }] });
const plan = await cascade.plans.create({ name: "Mug of the month", amount: "12.00", interval: "month" });
await cascade.subscriptions.create({ planId: plan.id, customer: { name: "Ines" }, prepaidPeriods: 3 });`,
  },
  {
    title: "Charge AI agents per request (x402)",
    body: "Unpaid requests get HTTP 402 with payment options; agents pay in any coin, or from an on-chain budget on NEAR.",
    code: `import { x402Guard } from "@cascade/sdk/x402";
const guard = x402Guard(cascade, { price: "0.10", description: "One forecast" });
export async function GET(req: Request) {
  const g = await guard(req);
  return g.paid ? Response.json(forecast(), { headers: g.headers }) : g.response;
}`,
  },
  {
    title: "AI assistants (MCP)",
    body: "Run your account from Claude, Cursor or any MCP client, and let agents pay x402 APIs from a budget with limits the contract enforces.",
    code: `claude mcp add cascade --env CASCADE_URL=https://<your-cascade-host> \\
  --env CASCADE_SECRET_KEY=rk_live_… -- npx tsx packages/mcp/src/main.ts`,
  },
];

const endpoints: [string, string, string][] = [
  ["POST", "/v1/checkout/sessions", "Create a session (amount in USDC base units)"],
  ["GET", "/v1/checkout/sessions/:id", "Retrieve a session"],
  ["POST", "/v1/checkout/sessions/:id/refunds", "Refund in the customer's coin and chain"],
  ["POST", "/v1/invoices", "Create a hosted invoice"],
  ["POST", "/v1/plans · /v1/subscriptions", "Recurring billing"],
  ["GET", "/v1/customers", "Customers with lifetime totals"],
  ["POST", "/v1/x402/prepare · /v1/x402/settle", "Agent payments (used by x402Guard)"],
  ["GET", "/v1/merchant/payouts · escrows · agents", "Money out, read from the chain"],
  ["POST", "/v1/merchant/keys", "Read-only keys (rk_) for your team"],
  ["POST", "/v1/merchant/payout", "Settlement chain (needs your NEAR signature)"],
  ["GET", "/v1/reports/ledger.csv", "Accounting export"],
];

export default function Developers() {
  return (
    <div className="page">
      <DemoBanner />
      <Nav />
      <main className="container stack-lg" style={{ padding: "56px 24px 72px", maxWidth: 980 }}>
        <div className="stack" style={{ maxWidth: 720 }}>
          <div className="eyebrow">Developers</div>
          <h1 className="h1">Ten lines to accept any coin.</h1>
          <p className="soft" style={{ margin: 0 }}>
            A dependency-free TypeScript SDK and a REST API. Test with a sandbox account (secret key <span className="mono">sk_test_…</span>), then switch to live keys: nothing else changes.
          </p>
          <div className="row-start" style={{ flexWrap: "wrap" }}>
            <a className="btn sm" href="/start">Get a sandbox key</a>
            <a className="btn ghost sm" href="https://github.com/timioni001/cascade" target="_blank" rel="noreferrer">Source and docs <ArrowUpRight size={14} /></a>
          </div>
        </div>

        {blocks.map((b) => (
          <section key={b.title} className="card stack">
            <div className="h2">{b.title}</div>
            <p className="small soft" style={{ margin: 0 }}>{b.body}</p>
            <pre className="mono" style={{ margin: 0, background: "var(--card-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 16, whiteSpace: "pre-wrap", lineHeight: 1.65, fontSize: 12.5 }}>{b.code}</pre>
          </section>
        ))}

        <section className="card stack">
          <div className="h2">API reference</div>
          <p className="small soft" style={{ margin: 0 }}>Authenticate with <span className="mono">Authorization: Bearer sk_…</span>. Read-only keys can call every GET. Idempotency: send <span className="mono">Idempotency-Key</span> on creates.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <tbody>
                {endpoints.map(([m, p, d]) => (
                  <tr key={p}><td style={{ width: 70 }}><span className="badge neutral">{m}</span></td><td className="mono" style={{ whiteSpace: "nowrap" }}>{p}</td><td className="small soft">{d}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card stack">
          <div className="h2">Sandbox and live</div>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th /><th>Sandbox</th><th>Live</th></tr></thead>
              <tbody>
                <tr><td>Network</td><td>NEAR testnet</td><td>NEAR mainnet</td></tr>
                <tr><td>Customer payments</td><td>Simulated swap, real contracts and receipts</td><td>Real, through NEAR Intents (1Click)</td></tr>
                <tr><td>Keys</td><td>sk_test_ / rk_test_</td><td>sk_live_ / rk_live_</td></tr>
                <tr><td>Access</td><td>Instant, at /start</td><td>After a short review</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
