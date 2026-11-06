# Cascade

Checkout for NEAR Intents: let anyone pay you with any coin on any chain, and receive exactly the US dollars you asked for (USDC on NEAR), in your own account or your team's DAO. People pay through a button; AI agents pay through HTTP 402.

A small ceramics studio sells a $25 mug to a customer abroad who holds ETH on Base. Card processing is slow and expensive to set up in much of the world; plain crypto means telling the customer which coin, which chain and which address, and then checking a block explorer by hand. With Cascade the shop adds one button. The customer picks the coin they already have and pays from their wallet (or scans a QR code); the shop receives exactly $25.00 in USDC on NEAR, an on-chain receipt anyone can verify, and a signed webhook that tells its server to ship. Sales can be split automatically with collaborators or a DAO, refunds go back in the customer's own coin, and an AI agent can buy from the shop's API the same way. Cascade never holds the shop's money: NEAR Intents delivers it straight to the shop's account, its DAO, or an on-chain split. The same rails let a freelancer invoice a client and a team run payroll after its DAO approves, with no network fees for anyone.

> **Status (2026-11-03):** everything below runs locally against a real NEAR node (the sandbox) and is tested. Deployment plan: all contracts live on **NEAR testnet** with a public demo (the cross-chain swap is simulated there, because NEAR Intents has no testnet), plus a small **mainnet proof** of real 1Click payments (about $3). Deploying the contracts to mainnet would lock ~15-20 NEAR of storage, over this project's hackathon budget. Scripts and steps: [runbook](docs/mainnet-runbook.md). Links will appear under [Proof](#proof).

## For merchants

```ts
// Your server (the secret key never leaves it)
import { Cascade } from "@cascade/sdk/server";
const cascade = new Cascade({ apiKey: process.env.CASCADE_SECRET_KEY! });
const session = await cascade.checkout.create({ amount: "25.00", description: "Stoneware mug", reference: order.id }, { idempotencyKey: order.id });

// Your page: a "Pay with any crypto" modal
import { openCheckout } from "@cascade/sdk/browser";
openCheckout({ sessionUrl: session.url });

// Your webhook endpoint
import { verifyWebhook } from "@cascade/sdk/webhooks";
const event = await verifyWebhook(rawBody, req.headers["cascade-signature"], process.env.CASCADE_WEBHOOK_SECRET!);
if (event.type === "checkout.session.completed") ship(event.data.session.reference);

// An API that AI agents pay for per call (x402 v2)
import { x402Guard } from "@cascade/sdk/x402";
const guard = x402Guard(cascade, { price: "0.10", description: "One forecast" });
export async function GET(req: Request) {
  const g = await guard(req);
  return g.paid ? Response.json(forecast(), { headers: g.headers }) : g.response;
}

// Refund part of an order, in the coin and on the chain the customer paid with
const refund = await cascade.refunds.create(session.id, { amount: "10.00" }); // then sign refund.calls with your NEAR key
```

- **Onboarding** is a signed message (NEP-413) from the receiving NEAR account, or from a preparer its DAO approved, so nobody can open a merchant account that pays into an account they do not control.
- **Revenue splits:** create a split once on-chain (`create_split`, e.g. 80% shop / 15% illustrator / 5% a DAO); sessions with `splitId` are divided by the contract the moment the money arrives.
- **Receipts:** every paid session has a public page (`/r/<session>`) that rechecks the on-chain record, its binding to the order, and the delivery.
- **Fees:** an optional Cascade fee is added for the customer through 1Click `appFees`; the merchant always receives the exact amount.
- **Settle where you want:** USDC on NEAR (default), Ethereum, Base, Arbitrum or Solana; 1Click delivers there directly. Changing it needs a NEP-413 signature from the merchant's account, so a leaked API key cannot redirect money. The receipt is still recorded on NEAR.
- **Invoices:** numbered invoices with line items and due dates, a hosted page (`/i/<id>`) the customer pays with any coin, printable to PDF, one `invoice.overdue` reminder.
- **Subscriptions:** plans billed every day, week, month or year. Crypto has no card on file, so renewal invoices go out before each period ends; customers can prepay up to 12 periods. Unpaid renewals become `past_due`, then `canceled`. **Customers** are aggregated across invoices and subscriptions.
- **Milestone escrow (on-chain):** `create_escrow` with up to 20 milestones; the customer funds it through an ordinary checkout from any chain (1Click delivers into the contract); only the payer (or an arbiter) releases a milestone to the payee, refunds only go to the payer, and anyone can return unreleased money after the refund date.
- **Agent budgets (on-chain):** an owner gives an AI agent an allowance with a per-payment limit, a daily limit, an expiry and optional allowed recipients. The agent pays x402 invoices with `agent_pay`, gaslessly; the contract refuses anything outside the limits, and revoking returns the rest at once.
- **AI assistants (MCP):** `cascade-mcp` lets Claude, Cursor or any MCP client run the account ("invoice Fieldwork Café for 24 mugs") and lets an agent pay x402 APIs from its budget with `paid_fetch`. Every agent payment's receipt shows who authorized it, for what, and within which limits. Setup: [docs/mcp.md](docs/mcp.md).
- **Pay out from the dashboard view:** payouts to any chain, escrows with milestone progress (and a funding link the client pays in any coin), and agent budgets with today's spend.
- **Point of sale:** a merchant types an amount on a phone or tablet ([`/pos`](apps/web/app/pos/page.tsx)); the customer scans the QR and pays in any coin; the screen turns green when the money has arrived, with an on-chain receipt.
- **Self-serve onboarding:** instant sandbox accounts for anyone and a live-access application for businesses ([`/start`](apps/web/app/start/page.tsx)).
- **Team access:** read-only keys (`rk_…`) for an accountant or a support tool can see everything and change nothing.

```ts
const inv = await cascade.invoices.create({ customer: { name: "Fieldwork Café" }, items: [{ description: "Stoneware mug", quantity: 24, unitAmount: "18.00" }] });
const plan = await cascade.plans.create({ name: "Mug of the month", amount: "12.00", interval: "month" });
await cascade.subscriptions.create({ planId: plan.id, customer: { name: "Ines" }, prepaidPeriods: 3 });
await cascade.checkout.create({ amount: "800.00", description: "Custom tableware", escrowId: 0 }); // funds escrow #0
const readOnly = await cascade.merchant.keys.create({ role: "read", label: "Accountant" });
```

## Use it

| | Who | How |
| --- | --- | --- |
| **Sandbox** | Anyone, instantly | [`/start`](https://cascade.timioni1490.workers.dev/start) creates a real NEAR testnet account for your business, registers it with Cascade and gives you secret keys, the dashboard and the point of sale. Customer payments are simulated; contracts and receipts are real. |
| **Live** | Businesses | Apply at [`/start`](https://cascade.timioni1490.workers.dev/start). Live keys are issued after a short review; the API and dashboard are the same as in the sandbox. |
| **Developers** | | [`/developers`](https://cascade.timioni1490.workers.dev/developers): quickstart, API reference, webhooks, x402, MCP. |

Live testnet deployment: **[cascade.timioni1490.workers.dev](https://cascade.timioni1490.workers.dev)**: [demo shop](https://cascade.timioni1490.workers.dev/shop), [point of sale](https://cascade.timioni1490.workers.dev/pos), [dashboard](https://cascade.timioni1490.workers.dev/dashboard).

## Try it locally

Requirements: Node 22.13+, pnpm 10, internet access for the first run (downloads the NEAR sandbox node, ~90 MB). No keys, no money, no Rust.

```sh
pnpm i
pnpm demo     # every story end to end in the terminal, 38 checks, ~80 s
pnpm dev      # the same stack, clickable: open http://localhost:3000/shop
pnpm worker:local   # the same, running inside the real Cloudflare Worker runtime with D1, on :8787
```

### `pnpm dev`: click through it

1. Open http://localhost:3000/shop. You see the demo shop, "Oakline Ceramics", already onboarded as a merchant on the local chain.
2. Press **Pay with any crypto**. The Cascade checkout opens in a modal (an iframe on the Cascade origin).
3. Pick **ETH on Base**. You see the exact ETH amount for $25.00 from a (mock) quote, and that the price includes a 0.3% fee while the shop receives exactly $25.00.
4. Paste any address as your refund address and press **Get payment address**. You see a one-time deposit address and a QR code your phone wallet can scan. With a browser wallet such as MetaMask installed, **Pay with wallet** sends the transaction instead.
5. Press **Simulate the payment (sandbox)**. Within a few seconds the checkout shows **Paid**; **Verify receipt** opens a page with four green checks recomputed from the chain.
6. Press Escape. The shop page now says **Order … paid. Shipping soon.** That status comes from the shop's own server, which verified the signed webhook.
7. Open http://localhost:3000/dashboard and paste the secret key printed in the terminal: sessions, webhook log with retries, CSV export, and **Refund** on any paid session.
8. In another terminal run `pnpm agent`: an AI agent requests the shop's paid forecast API, receives HTTP 402 with two ways to pay, pays one, and gets the data.

### `pnpm demo`: what it runs

1. **Ada signs up** and gets `ada.cascade.sandbox` from the factory: no seed phrase, NEAR for storage paid by Cascade.
2. **Ada invoices** a client for $300; **the client pays in ETH on Base**; the settler marks the invoice Paid on-chain. Someone pays her **public link** with SOL; it is recorded as a receipt.
3. **Ada splits** $200 to Solana, Base (private) and NEAR in one batch with one signature.
4. **Her studio is a Sputnik DAO** (the real v2 contract from mainnet). It joins Cascade through its own proposal, receives $1,500 from Arbitrum, and runs payroll on three chains after 2 of 3 approvals. A preparer cannot fund it alone; a frozen recipient's $100 goes back to the DAO automatically.
5. **A ceramics studio onboards to Checkout** with a signed NEP-413 message, creates a session with the SDK, a customer pays in ETH on Base, the shop receives exactly $25.00, a receipt bound to the session is written on-chain, and the shop's server verifies the webhook (and rejects a forged one).
6. **Revenue split:** the shop's next sale is split 80/15/5 between the shop, an illustrator and the studio DAO, on arrival, with no signatures: $20.00 / $3.75 / $1.25.
7. **Refund:** $10 goes back to the first customer as ETH on Base; the shop signs twice (create, fund) and receives `refund.succeeded`.
8. **AI agent:** an agent pays the shop's API over x402 and gets its data; replaying the same payment is refused.
9. **The rest of the platform:** the shop switches its payout to USDC on Base (signed), bills a café a $467 invoice paid in SOL, starts a subscription with 3 months prepaid, runs an $800 milestone escrow funded from Base (one milestone released, one refunded), and gives an AI agent a $5 budget with on-chain limits that pays over x402 without holding any NEAR.
10. The accountant's CSV is printed, then 38 checks run. Ada, the approvers, the shop and the customer pay no network fees. The command exits non-zero if any check fails.

## Proof

| What | Where | Link |
| --- | --- | --- |
| Live demo (shop, checkout, point of sale, dashboard, sandbox sign-up) | NEAR testnet, Cloudflare | [cascade.timioni1490.workers.dev](https://cascade.timioni1490.workers.dev) |
| First live checkout: $25.00 paid, receipt #0 recorded on-chain | NEAR testnet | [receipt](https://cascade.timioni1490.workers.dev/r/cs_aIGePC35X1T6gDz0Il) · [transaction](https://testnet.nearblocks.io/txns/2zxX5hs1mhN7BibqsZ9TZwUythmfmqZagzZXC233fY7M) |
| Contracts (app locked, factory, mock USDC) | NEAR testnet | `deployments/testnet.json` |
| $1 paid from Base, received as USDC on NEAR via 1Click | Mainnet | to be added (`pnpm spike incoming`) |
| $1 sent from NEAR back to Base via 1Click | Mainnet | to be added (`pnpm spike outgoing`) |

## Tests

```sh
pnpm test:unit       # 92 TypeScript unit tests (seconds)
pnpm test:sandbox    # 31 tests against a local NEAR node with real receipts, incl. the deploy script (~2 min)
pnpm test            # both
pnpm test:contracts  # 41 Rust unit tests (needs Rust)
pnpm test:e2e        # optional browser test: button, QR, receipt, dashboard (needs Playwright; run pnpm dev first;
                     # CASCADE_WEB=http://localhost:8787 to test the Worker from pnpm worker:local)
```

Each safety rule has a test at the contract level (`contracts/app/src/tests.rs`) and on a real node (`contracts/tests/safety.test.ts`):

| Rule | Unit test | Sandbox test |
| --- | --- | --- |
| No line is paid before its batch is funded | `rule1_no_line_is_paid_before_the_batch_is_funded` | `execute_batch on an unfunded batch fails` |
| No line is ever paid twice | `rule1_no_line_is_ever_paid_twice`, `invariant_holds_under_random_walks` | `two cranks racing in the same block pay each line exactly once` |
| Only a team's DAO can fund the team's batch; only the owner can fund a personal batch | `rule2_*` | `someone else's ft_transfer_call is returned in full`, `a DAO's preparer cannot fund` |
| Wrong amount or hash: all the money goes back | `rule3_wrong_amount_or_hash_or_token_returns_everything` | `short amount, extra amount and wrong hash are each refunded in full` |
| Sent + Refunded + Queued always equals the batch total | `rule4_buckets_always_add_up_through_failure_and_refund` | `holds for every batch in this sandbox` |
| A split always pays out exactly what arrived; unknown splits are refunded | `split_parts_always_add_up_and_never_overflow`, `split_rejections_return_everything` | `the contract refunds payments to an unknown split in full, and splits valid ones exactly` |

## How NEAR is used

| NEAR feature | Where | What it does for the user |
| --- | --- | --- |
| NEAR Intents via the 1Click API | `packages/oneclick`, `packages/engine` | Customer pays with any coin on any chain; the merchant receives exactly the USDC asked for (`EXACT_OUTPUT`). Payouts and refunds reach any chain |
| 1Click `customRecipientMsg` | `packages/engine/src/checkout.ts` | Delivers a payment straight into an on-chain revenue split (experimental in 1Click; mainnet test pending) |
| 1Click `appFees` | `packages/engine/src/checkout.ts` | A transparent Cascade fee paid by the customer |
| x402 v2 (with NEAR Intents as the rail) | `packages/sdk/src/x402.ts`, `packages/engine/src/x402.ts` | AI agents pay per request with any coin; the merchant gets USDC on NEAR |
| NEP-413 signed messages | `packages/engine/src/checkout.ts` | Merchant onboarding proves control of the receiving account (or DAO preparer role) |
| Confidential Intents | `packages/oneclick/src/intents.ts` (`confidentiality: "basic"`) | Private payout lines. Needs the 1Click partner JWT; not yet tested on mainnet ([spikes](docs/spikes.md)) |
| Meta-transactions (NEP-366) | `packages/near/src/meta.ts`, `services/relayer` | Users, merchants and DAO approvers never pay gas |
| Named accounts | `contracts/factory` | `ada.cascade.near` is the payment address. No seed phrase |
| Function-call access keys | `contracts/factory` (`app_key`) | Everyday actions are signed by a key that can only call Cascade |
| Sputnik DAO v2 | `packages/sputnik`, `scripts/sandbox/flows.ts` | Teams keep custody; payroll is one proposal; members vote fee-free; a DAO can be a split recipient |
| NEP-141 `ft_transfer_call` | `contracts/app` `ft_on_transfer` | Funding a batch or paying into a split is one transfer that the contract checks or returns in full |

## What works today

| Piece | State |
| --- | --- |
| App contract: owners, invoices, link receipts, batches, chunked payouts, refunds, quote deadlines, revenue splits, milestone escrow, agent allowances | Done, unit and sandbox tested |
| Name factory with limited app key and USDC registration | Done, tested |
| 1Click client, Cascade quoting rules, MockOneClick | Done; real API checked with free dry quotes ([research](docs/research.md)) |
| Relayer (NEP-366) with allowlist and rate limits; settler crank (discovers split payouts) | Done, tested |
| Checkout API: onboarding, keys, idempotent sessions, expiry, fees, splits, refunds, x402, receipts, webhook log, CSV | Done, unit and sandbox tested |
| Billing: payout preference (signed), invoices, plans, subscriptions with renewals and prepaid periods, customers, read-only keys, escrow-funded checkout, x402 from on-chain agent allowances | Done, unit and sandbox tested; dashboard and hosted invoice page browser-tested |
| `@cascade/sdk`: server client, webhooks, Pay button, EVM wallet payments, QR payment URIs, x402 guard and client | Done, tested; no runtime dependencies |
| Web: landing page, hosted checkout (steps, fee shown upfront, QR, wallet pay), paper receipt with live checks, merchant dashboard (balance, revenue chart, payments, refunds, webhooks, CSV), demo shop, x402 demo API | Done, browser-tested at desktop and phone widths |
| Testnet demo mode (`CASCADE_ONECLICK=mock`) and demo-merchant setup script | Done; refused on mainnet (tested) |
| Cloudflare: one Worker (pages, API, relayer, demo shop) on D1 with a cron settler, free plan | Done; browser e2e, x402 agent and cron run against the Worker locally (`pnpm worker:local`) ([hosting](docs/hosting.md)) |
| Node server alternative (same platform code), Dockerfile | Done; browser e2e against it (`pnpm dev:static`) |
| Deploy and mainnet test scripts | Done; deploy rehearsed on a local node ([runbook](docs/mainnet-runbook.md)) |
| Solana (Phantom) and NEAR wallet buttons | Not yet: those payers use the QR code or the deposit address |
| AI assistant on NEAR AI Cloud | Cut |
| Testnet deployment, hosting, mainnet 1Click proof | Ready to run; each step needs approval ([runbook](docs/mainnet-runbook.md)) |

Mainnet transaction links will be listed here once they exist.

## Threat model

Our servers can delay things and the settler can wrongly mark an invoice paid, but nothing we run can move money anywhere it was not already headed. Details: [docs/threat-model.md](docs/threat-model.md).

- **Who can move money:** an owner (their own batches and refunds), a DAO (after its vote), and the app contract (only to locked lines and split shares, and refunds only to the owner). No admin withdrawal exists; the app account has no keys.
- **Settler:** trusted to report what 1Click delivered; it only writes records, each deposit address once.
- **Relayer:** pays gas for an allowlist of calls; it cannot change what users signed.
- **Checkout:** Cascade never receives checkout money (1Click's recipient is the merchant or its split). Secret keys are stored hashed; webhooks are HMAC-signed with a timestamp; refunds need the merchant's own signatures; an x402 payment unlocks one response for one URL.
- **Keys in the browser:** a lost browser means a lost account until the user backs up the key; the web app must prompt for that.

## Deploying (testnet, then mainnet)

`pnpm deploy:cascade` and `pnpm spike <name>` run from your machine with keys in `.env`; every transaction is shown and needs a typed `yes`. The app contract is deployed **locked** (no access keys), so nobody can change it or move its funds. Step by step: [docs/mainnet-runbook.md](docs/mainnet-runbook.md). The deploy script itself is tested against a local node (`contracts/tests/deploy.test.ts`).

## Hosting

One deployment serves everything: the pages, the checkout API (`/v1`), the relayer (`/relayer`), the demo shop and the settler. On **Cloudflare** it is one Worker with D1 and a cron trigger, on the free plan; nothing needs to stay up on your machine. The same platform code also runs as one Node process (`pnpm backend`, or Docker). Contract ids come from `deployments/<network>.json`, secrets from `.env`.

```sh
pnpm cf:configure --url https://cascade.<you>.workers.dev --database-id <id>
pnpm cf:deploy
```

Step by step, limits and settings: [docs/hosting.md](docs/hosting.md).

## Documentation

- [docs/architecture.md](docs/architecture.md): money flow, owners, repository layout, design decisions
- [docs/threat-model.md](docs/threat-model.md)
- [docs/research.md](docs/research.md): hackathon rules, 1Click, x402 and NEAR facts we verified, gotchas found
- [docs/spikes.md](docs/spikes.md): the mainnet tests still to run
- [docs/mainnet-runbook.md](docs/mainnet-runbook.md) and [docs/hosting.md](docs/hosting.md)
- [docs/upstream-reports.md](docs/upstream-reports.md): issues found in Sputnik DAO, near-sdk and 1Click, with reproductions
- [contracts/res/README.md](contracts/res/README.md): where each wasm comes from

## Built at NEAR HACKATHON

Tracks: Real-World Money (`realworld`), Social Money (`social`). See [HACKATHON.md](HACKATHON.md) for the code diff and disclosures.

## License

MIT, see [LICENSE](LICENSE).
