# Cascade

Payments infrastructure on NEAR. A business is paid in any coin on any chain and receives the exact amount it asked for in USDC. Every payment leaves a receipt on NEAR that anyone can verify. Checkout, point of sale, invoices, subscriptions, payouts, DAO payroll, revenue splits, milestone escrow, refunds, and payments by AI agents (x402 and MCP).

![Cascade landing page](docs/media/screens/landing.png)

| | |
| --- | --- |
| **Live (NEAR testnet)** | [cascade.timioni1490.workers.dev](https://cascade.timioni1490.workers.dev) |
| **Mainnet proof** | Real payments through NEAR Intents (1Click), Base → NEAR and NEAR → Base: [Proof](#proof) |
| **Run it locally** | `pnpm i && pnpm demo` (one command, no keys, no money, ~80 s, 38 checks) |
| **Tests** | 95 unit · 31 on a local NEAR node · 41 Rust contract · browser end-to-end |
| **Tracks** | Real-World Money (`realworld`), Social Money (`social`) · disclosures in [HACKATHON.md](HACKATHON.md) |
| **License** | MIT |

## Contents

1. [The problem](#the-problem)
2. [Why it needs a chain, and why NEAR](#why-it-needs-a-chain-and-why-near)
3. [What it can do](#what-it-can-do)
4. [How it works](#how-it-works)
5. [Try it on the live site](#try-it-on-the-live-site)
6. [Run it locally](#run-it-locally)
7. [Screens](#screens)
8. [Proof](#proof)
9. [For developers](#for-developers)
10. [Numbers](#numbers)
11. [Tests](#tests)
12. [Security model](#security-model)
13. [Repository layout](#repository-layout)
14. [Deploy and host](#deploy-and-host)
15. [Status and limits](#status-and-limits)
16. [Documentation](#documentation)

## The problem

A business that sells across borders has two options today.

- **Cards and bank transfers:** typically 2.9% + $0.30 per online card payment ([Stripe US pricing](https://stripe.com/pricing)), more for international cards, and not available to merchants in much of the world. Sending money across borders costs 6.49% on average ([World Bank, Remittance Prices Worldwide, Q1 2025](https://remittanceprices.worldbank.org/sites/default/files/rpw_main_report_and_annex_q125_1_0.pdf)).
- **Crypto:** customers already hold dollars and other assets on many chains. But accepting them means telling the customer which coin, which chain and which address, checking a block explorer by hand, and matching the payment to an order. Refunds, payroll and splits are manual transfers.

Cascade makes it one button. The customer pays with what they already hold. The business receives exactly $25.00 in USDC, together with an order-bound receipt on NEAR and a signed webhook.

## Why it needs a chain, and why NEAR

Each property below would need trust in a company if it ran on a database. On NEAR, a contract enforces it, or the chain records it.

| Need | Without a chain | With Cascade on NEAR |
| --- | --- | --- |
| Accept any coin, receive one currency | A custodian swaps and holds funds | **NEAR Intents (1Click)** swaps and delivers `EXACT_OUTPUT` USDC straight to the merchant. Cascade never holds checkout money |
| Proof a payment happened, for this order | The processor's word | A **receipt on the Cascade contract**, bound to the order hash and the one-time deposit address. Anyone can re-check it at `/r/<id>` |
| Split a sale between partners | A trusted party pays everyone later | The contract divides the payment the moment it arrives (`ft_on_transfer`) |
| Payroll for a team or a community | One person controls the bank account | A **Sputnik DAO v2** proposal funds a locked batch. Members vote, and no single preparer can move the money |
| Escrow for milestone work | An escrow company | The contract holds the funds. Only the payer or an arbiter can release a milestone, and refunds can only go back to the payer |
| Let an AI agent spend money safely | Shared card numbers | **On-chain allowances**: per-payment and daily limits, expiry, allowed recipients, revocable. The agent's mandate appears on every receipt |
| No gas, no seed phrase for users | n/a | **Meta-transactions (NEP-366)** through a relayer, **named accounts** from a factory, **NEP-413** signed messages for onboarding |

## What it can do

The status column says how each feature was verified:
- **Mainnet:** real money on NEAR mainnet.
- **Testnet:** on the live testnet site.
- **Local node:** in tests and `pnpm demo` against a real NEAR node running locally.

| Feature | What the user gets | Status |
| --- | --- | --- |
| **Any-coin checkout** | Pay button, hosted page, QR code, browser-wallet payment. 200+ assets on 35+ chains through 1Click. The fee is shown upfront and the merchant receives the exact amount | Mainnet (1Click delivery) · Testnet (swap simulated) |
| **On-chain receipts** | `/r/<id>` re-checks four facts from the chain on every load: recorded, bound to the order, same deposit address, delivered | Testnet ([first receipt](https://cascade.timioni1490.workers.dev/r/cs_aIGePC35X1T6gDz0Il)) |
| **Signed webhooks** | HMAC with a timestamp, retries with backoff, a delivery log. The demo shop ships only on a verified webhook | Testnet · Local node |
| **Point of sale** | `/pos`: type an amount, the customer scans, the screen turns green when the money arrives | Testnet · Local node |
| **Invoices** | Numbered, with line items and due dates. A hosted page payable in any coin, printable to PDF, with an overdue reminder | Local node · browser-tested |
| **Subscriptions** | Plans billed every day, week, month or year. Renewal invoices go out before each period, up to 12 periods can be prepaid, and unpaid plans go past due, then cancelled | Local node · browser-tested |
| **Customers** | Aggregated across invoices and subscriptions | Local node |
| **Settle on any chain** | USDC on NEAR, Ethereum, Base, Arbitrum or Solana. A change needs a NEP-413 signature from the merchant's account, so a leaked API key cannot redirect money | Local node. Mainnet delivery NEAR → Base verified |
| **Refunds** | Partial or full, back in the customer's coin and chain, through a hash-locked batch line | Local node |
| **Payouts and payroll** | Up to 50 recipients, each on their own chain, in one locked batch. Chunked execution, and failed lines return to the owner | Local node. Mainnet NEAR → Base verified |
| **DAO payroll** (`social`) | A Sputnik DAO v2 team joins through its own proposal. Payroll is one proposal with fee-free votes, and a preparer can never fund alone | Local node, with the real Sputnik v2 wasm from mainnet |
| **Revenue splits** | e.g. 80/15/5 between a shop, an illustrator and a DAO, split on arrival with no signatures | Local node. 1Click `customRecipientMsg` on mainnet not yet tested |
| **Milestone escrow** | Up to 20 milestones, funded by the client from any chain, released per milestone, refundable to the client after a date | Local node · release/refund buttons in the dashboard |
| **AI agent budgets** | `set_allowance` with limits the contract enforces. The agent pays gas-free with `agent_pay`, and revoking returns the balance | Local node |
| **x402 paywalls** | `x402Guard` returns HTTP 402 with payment options, and one payment unlocks one response. `pnpm agent` shows the full loop | Local node · Testnet |
| **MCP server** | Claude, Cursor or any MCP client can run the account ("invoice Fieldwork Café for 24 mugs") and spend an agent budget (`paid_fetch`) | Local node ([docs/mcp.md](docs/mcp.md)) |
| **NEAR wallet in the dashboard** | NEAR Connect (HOT, Meteor, Intear, MyNearWallet, OKX…). The merchant's own wallet signs escrow releases, agent budgets and payout changes, and Cascade never holds the key | Built. Real-wallet run still to be recorded |
| **Self-serve sandbox** | `/start` creates a real testnet account through the factory, registers it gas-free, onboards it with NEP-413, and returns API keys in seconds | Testnet |
| **Live-access applications** | Businesses apply at `/start`. Applications are stored for review | Testnet |
| **Team keys** | Read-only `rk_` keys for an accountant or a support tool, and an accountant CSV export | Local node · browser-tested |
| **Cascade fee** | 0.5% through 1Click `appFees`, paid by the customer, shown on the checkout. The merchant still receives the exact amount | Implemented. Measured on mainnet (dry quote, with and without a 1Click key): 1Click keeps half, so Cascade nets 0.25% today ([spikes](docs/spikes.md)) |

## How it works

### A checkout payment

```mermaid
%%{init: {"theme": "neutral"}}%%
sequenceDiagram
    autonumber
    participant S as Shop server
    participant C as Cascade API
    participant B as Customer
    participant I as NEAR Intents (1Click)
    participant N as Cascade contract (NEAR)
    S->>C: create session ($25.00, order id)
    C-->>S: session url
    B->>C: open checkout, pick "ETH on Base"
    C->>I: EXACT_OUTPUT quote: 25.00 USDC to the merchant (+0.5% fee)
    I-->>B: one-time deposit address + QR
    B->>I: send ETH on Base
    I->>N: deliver exactly 25.00 USDC to the merchant on NEAR
    C->>N: settler records the receipt (order hash, deposit address)
    C-->>S: signed webhook: checkout.session.completed
    B->>N: receipt page re-checks the record on the chain
```

### Architecture

```mermaid
%%{init: {"theme": "neutral"}}%%
flowchart LR
    subgraph Browser
      W[Web app: checkout, POS, dashboard, receipts]
      NC[NEAR Connect wallet]
    end
    subgraph "Cloudflare Worker (one deployment)"
      API[Checkout and billing API /v1]
      REL[Relayer /relayer: pays gas, NEP-366]
      SET[Settler, cron: records receipts, runs batches]
      DB[(D1)]
    end
    subgraph NEAR
      APP[Cascade app contract: receipts, batches, splits, escrow, allowances]
      FAC[Name factory]
      DAO[Sputnik DAO v2]
      USDC[USDC NEP-141]
    end
    OC[1Click / NEAR Intents: 35+ chains]
    W --> API
    W --> REL
    NC --> APP
    API --> DB
    API --> OC
    SET --> OC
    SET --> APP
    REL --> APP
    REL --> FAC
    OC --> USDC --> APP
    DAO --> APP
```

### Team payroll approved by a DAO (`social`)

```mermaid
%%{init: {"theme": "neutral"}}%%
sequenceDiagram
    participant P as Preparer
    participant D as Sputnik DAO
    participant A as Cascade contract
    participant I as 1Click
    P->>A: create batch (50 lines, each on its own chain), hash locked
    P->>D: proposal: ft_transfer_call(total, batch hash)
    Note over D: members vote gas-free (relayed)
    D->>A: funds the batch (contract checks amount and hash, else refunds all)
    A->>I: execute lines in chunks
    I-->>A: delivered, or failed and returned to the DAO
```

### An AI agent paying an API (x402)

```mermaid
%%{init: {"theme": "neutral"}}%%
sequenceDiagram
    participant O as Owner wallet
    participant A as Cascade contract
    participant G as Agent (MCP paid_fetch)
    participant M as Merchant API (x402Guard)
    O->>A: set_allowance(agent, $5/payment, $20/day, expiry, purpose)
    O->>A: fund with ft_transfer_call
    G->>M: GET /forecast
    M-->>G: 402 Payment Required (price, pay-to)
    G->>A: agent_pay (relayed, no gas), limits enforced
    G->>M: retry with payment proof
    M-->>G: 200 + data · receipt shows owner, mandate and limits
```

## Try it on the live site

The live site runs on NEAR testnet. Contracts, accounts, receipts and webhooks are real there. The cross-chain swap is simulated, because NEAR Intents has no testnet; real swaps are shown on mainnet under [Proof](#proof).

| Do | See |
| --- | --- |
| Open [/shop](https://cascade.timioni1490.workers.dev/shop), press **Pay with any crypto**, pick **ETH on Base** | The exact ETH amount, the 0.5% fee line, and "Oakline Ceramics receives $25.00" |
| Enter any Base address as the refund address, press **Get payment address** | A one-time deposit address and a QR code |
| Press **Simulate the payment** | Within seconds, **Payment complete** |
| Press **Verify receipt** | Four green checks recomputed from NEAR, with a link to the transaction |
| Close the checkout | The shop says **Order … paid**. Its server verified the signed webhook |
| Open [/start](https://cascade.timioni1490.workers.dev/start), enter a business name, press **Create a sandbox account** | A new `sbx-…` testnet account, a secret key and the account key |
| Press **Point of sale**, type `12.50`, press **Charge $12.50** | A QR code. After paying, the screen turns green with an on-chain receipt |
| Open [/dashboard](https://cascade.timioni1490.workers.dev/dashboard) with the secret key | Balance, revenue chart, payments, refunds, invoices, subscriptions, payouts, escrow, agents, webhooks, CSV |
| In the dashboard, open **Agents** and press **Connect NEAR wallet** | The wallet picker, and a form whose limits your own wallet signs |
| Open [/developers](https://cascade.timioni1490.workers.dev/developers) | Quickstart, API reference, webhooks, x402, MCP |

## Run it locally

Requirements: Node 22.13+ and pnpm 10. The first run needs internet access, because it downloads the NEAR sandbox node (~90 MB). You don't need keys, money or Rust.

```sh
pnpm i
pnpm demo          # every story end to end in the terminal, 38 checks, exits non-zero on failure
pnpm dev           # the same stack, clickable at http://localhost:3000 (prints a merchant secret key)
pnpm agent         # in a second terminal: an AI agent pays the shop's x402 API
pnpm worker:local  # the same inside the Cloudflare Worker runtime with D1, on :8787
```

`pnpm demo` runs these stories on a local NEAR node:
1. A freelancer gets a named account with no seed phrase.
2. She invoices $300, and the client pays in ETH on Base.
3. She splits $200 to Solana, Base and NEAR with one signature.
4. Her studio, a Sputnik DAO, joins through a proposal and runs payroll on three chains after 2 of 3 approvals. A frozen recipient's line returns to the DAO.
5. A shop onboards with NEP-413, takes $25 in ETH on Base and verifies the webhook. It also rejects a forged one.
6. A sale is split 80/15/5 on arrival.
7. A $10 refund goes back as ETH on Base.
8. An agent pays over x402, and a replay is refused.
9. The shop changes its payout chain, bills a $467 invoice paid in SOL, starts a prepaid subscription, and runs an $800 escrow (one milestone released, one refunded). It also gives an agent a $5 budget with on-chain limits.
10. Finally, the demo checks that nobody but the relayer paid gas.

## Screens

All captured from the running app (`pnpm test:e2e`). Light and dark themes are both available.

**Get paid**

| | |
| --- | --- |
| ![Shop](docs/media/screens/shop.png) | ![Choose a coin](docs/media/screens/checkout-quote.png) |
| Demo shop with a "Pay with any crypto" button | Pick any coin; the fee and the exact amount received are shown upfront |
| ![Deposit address](docs/media/screens/checkout-deposit.png) | ![Paid](docs/media/screens/checkout-paid.png) |
| One-time deposit address and QR | Payment complete |
| ![Order paid](docs/media/screens/shop-paid.png) | ![Receipt](docs/media/screens/receipt.png) |
| The shop marks the order paid from a verified webhook | Public receipt, re-checked from NEAR |
| ![Point of sale](docs/media/screens/pos.png) | ![Point of sale, paid](docs/media/screens/pos-paid.png) |
| Point of sale: amount and QR | Paid in person |
| ![Invoice](docs/media/screens/invoice.png) | ![Invoice paid](docs/media/screens/invoice-paid.png) |
| Hosted invoice, payable in any coin | Paid invoice |

**Run the business**

| | |
| --- | --- |
| ![Dashboard](docs/media/screens/dashboard.png) | ![Refund](docs/media/screens/refund.png) |
| Overview: balance, revenue, recent payments | Refund in the customer's own coin |
| ![Invoices](docs/media/screens/invoices.png) | ![Subscriptions](docs/media/screens/subscriptions.png) |
| Invoices | Plans and subscriptions |
| ![Customers](docs/media/screens/customers.png) | ![Webhooks](docs/media/screens/webhooks.png) |
| Customers | Webhook deliveries and retries |
| ![Reports](docs/media/screens/reports.png) | ![Settings](docs/media/screens/settings.png) |
| Accountant CSV | Team keys and a payout chain change signed by your NEAR wallet |

**Pay out, escrow and agents**

| | |
| --- | --- |
| ![Payouts](docs/media/screens/payouts.png) | ![Escrow](docs/media/screens/escrow.png) |
| Payout batches, every recipient on their own chain | Milestone escrow held by the contract |
| ![Agents](docs/media/screens/agents.png) | ![Developers](docs/media/screens/developers.png) |
| Agent budgets signed by your wallet, MCP setup | Developer portal |

**Access and mobile**

| | | |
| --- | --- | --- |
| ![Sandbox sign-up](docs/media/screens/start.png) | ![Dark](docs/media/screens/landing-dark.png) | ![Mobile checkout](docs/media/screens/mobile-checkout.png) |
| Sandbox account in seconds | Dark theme | Checkout on a phone |
| ![Mobile shop](docs/media/screens/mobile-shop.png) | ![Mobile landing](docs/media/screens/mobile-landing.png) | ![Mobile developers](docs/media/screens/mobile-developers.png) |
| Shop on a phone | Landing on a phone | Developers on a phone |

## Proof

| What | Network | Link |
| --- | --- | --- |
| Live app: shop, checkout, POS, dashboard, sandbox sign-up | NEAR testnet + Cloudflare | [cascade.timioni1490.workers.dev](https://cascade.timioni1490.workers.dev) |
| First live checkout: $25.00 paid, receipt #0 recorded on-chain | NEAR testnet | [receipt](https://cascade.timioni1490.workers.dev/r/cs_aIGePC35X1T6gDz0Il) · [transaction](https://testnet.nearblocks.io/txns/2zxX5hs1mhN7BibqsZ9TZwUythmfmqZagzZXC233fY7M) |
| Contracts: app (locked, no access keys), factory, mock USDC | NEAR testnet | [`deployments/testnet.json`](deployments/testnet.json) |
| **$1 paid in USDC on Base, received as exactly 1.00 USDC on NEAR** through 1Click | Mainnet | [Base tx](https://basescan.org/tx/0xd96897cadd46d529d3146471b791d70950f6299857a349f243db1e3e58505edf) → [NEAR tx](https://nearblocks.io/txns/FLf4dvUSLR2dEeJTHZXknjSybuipCbSpgSBU4sDqPKr8) (1.004745 in, 1.00 out) |
| **$1 sent from NEAR, received on Base** through 1Click | Mainnet | [NEAR tx](https://nearblocks.io/txns/AfevEhJpLCiPBnt5WumWi7nj8CMBvTFxsyXXZqLrLkcL) → [Base tx](https://basescan.org/tx/0x08672264184dedbf01082aa96551f58647074078fc8c3216f132a5dad672992b) (1.00 in, 0.997398 out) |
| Full records with quote signatures and deadlines | Mainnet | [`deployments/mainnet-spikes.json`](deployments/mainnet-spikes.json) |

## For developers

```ts
// Server: the secret key never leaves it
import { Cascade } from "@cascade/sdk/server";
const cascade = new Cascade({ apiKey: process.env.CASCADE_SECRET_KEY! });
const session = await cascade.checkout.create({ amount: "25.00", description: "Stoneware mug", reference: order.id }, { idempotencyKey: order.id });

// Page: the "Pay with any crypto" modal
import { openCheckout } from "@cascade/sdk/browser";
openCheckout({ sessionUrl: session.url });

// Webhook endpoint
import { verifyWebhook } from "@cascade/sdk/webhooks";
const event = await verifyWebhook(rawBody, req.headers["cascade-signature"], process.env.CASCADE_WEBHOOK_SECRET!);
if (event.type === "checkout.session.completed") ship(event.data.session.reference);

// An API that AI agents pay per call (x402 v2)
import { x402Guard } from "@cascade/sdk/x402";
const guard = x402Guard(cascade, { price: "0.10", description: "One forecast" });

// Billing
await cascade.invoices.create({ customer: { name: "Fieldwork Café" }, items: [{ description: "Stoneware mug", quantity: 24, unitAmount: "18.00" }] });
const plan = await cascade.plans.create({ name: "Mug of the month", amount: "12.00", interval: "month" });
await cascade.subscriptions.create({ planId: plan.id, customer: { name: "Ines" }, prepaidPeriods: 3 });
await cascade.refunds.create(session.id, { amount: "10.00" });
await cascade.merchant.keys.create({ role: "read", label: "Accountant" });
```

The SDK has no runtime dependencies. The REST API lives under `/v1` and authenticates with `sk_` keys (full) and `rk_` keys (read-only, GET only). For the MCP server, see [docs/mcp.md](docs/mcp.md).

**How NEAR is used, by file**

| NEAR feature | Where |
| --- | --- |
| NEAR Intents, 1Click API (`EXACT_OUTPUT`, `appFees`, `customRecipientMsg`, confidentiality) | `packages/oneclick`, `packages/engine/src/checkout.ts` |
| Cascade app contract: receipts, batches, splits, escrow, allowances | `contracts/app/src/lib.rs`, `contracts/app/src/vault.rs` |
| Named accounts with function-call keys | `contracts/factory` |
| Meta-transactions (NEP-366) | `packages/near/src/meta.ts`, `services/relayer` |
| NEP-413 signed messages (onboarding, payout changes) | `packages/engine/src/checkout.ts`, `apps/web/lib/wallet.ts` |
| NEP-141 `ft_transfer_call` funding, checked or returned in full | `contracts/app` (`ft_on_transfer`) |
| Sputnik DAO v2 | `packages/sputnik`, `scripts/sandbox/flows.ts` |
| NEAR Connect wallet | `apps/web/lib/wallet.ts`, `apps/web/app/dashboard/Wallet.tsx` |

## Numbers

**Cost to receive $100, by headline fee**

```mermaid
%%{init: {"theme": "neutral"}}%%
xychart-beta
    title "Fee on a $100 payment (USD)"
    x-axis ["Cascade 0.5%", "Crypto gateway 1%", "Online card 2.9% + $0.30", "Avg. remittance 6.49%"]
    y-axis "USD" 0 --> 7
    bar [0.50, 1.00, 3.20, 6.49]
```

Sources:
- Card: [Stripe US pricing](https://stripe.com/pricing).
- Crypto gateway: [Coinbase Commerce](https://help.coinbase.com/en/commerce/getting-started/fees), 1%.
- Remittance: [World Bank RPW, Q1 2025](https://remittanceprices.worldbank.org/sites/default/files/rpw_main_report_and_annex_q125_1_0.pdf).

On top of Cascade's fee, the customer pays the route cost. On the $1 mainnet test (Base → NEAR) that was 0.47%, and it includes fixed network costs. The merchant receives the exact amount either way.

**Market**

- NEAR Intents passed $30B in all-time volume across 35 chains ([Datawallet, Sept 2026](https://www.datawallet.com/crypto/near-protocol-statistics)).
- Estimates of filtered stablecoin volume in 2025 range from about $9T ([a16z via DL News](https://www.dlnews.com/articles/markets/stablecoin-volumes-triple-visa-as-a16z-projects-digital-dollars-to-hit-3tn-by-2030/)) to $10.8T ([BCG / Allium](https://digital-assets.fct.bcg.com/)).

**This repository**

| | |
| --- | --- |
| TypeScript (non-test) | ~13,000 lines across 8 packages and 6 services |
| Rust contracts | ~2,900 lines; app contract wasm 428,757 bytes, 38 public methods |
| Tests | ~2,700 lines: 95 unit, 31 local-node, 41 Rust, 38 demo checks, browser e2e |
| Runtime dependencies of the SDK | 0 |
| Worker bundle | ~153 KB gzipped |

```mermaid
%%{init: {"theme": "neutral"}}%%
pie title Automated checks by layer
    "TypeScript unit" : 95
    "Rust contract" : 41
    "Demo checks (local NEAR node)" : 38
    "Local NEAR node tests" : 31
```

## Tests

```sh
pnpm test:unit       # 95 TypeScript unit tests (seconds)
pnpm test:sandbox    # 31 tests on a local NEAR node, incl. the deploy script (~2 min)
pnpm test            # both
pnpm test:contracts  # 41 Rust unit tests (needs Rust)
pnpm test:e2e        # browser test (run pnpm dev first): shop, checkout, receipt, dashboard, invoices, POS, sign-up, phones
pnpm test:buttons    # clicks every button and checks every link on every page and dashboard tab (run pnpm dev first)
```

Each money-safety rule is tested twice: as a contract unit test (`contracts/app/src/tests.rs`) and on a real node (`contracts/tests/safety.test.ts`).

| Rule | Unit test | Node test |
| --- | --- | --- |
| No line is paid before its batch is funded | `rule1_no_line_is_paid_before_the_batch_is_funded` | `execute_batch on an unfunded batch fails` |
| No line is ever paid twice | `rule1_no_line_is_ever_paid_twice`, `invariant_holds_under_random_walks` | `two cranks racing in the same block pay each line exactly once` |
| Only a team's DAO can fund the team's batch | `rule2_*` | `a DAO's preparer cannot fund` |
| Wrong amount or hash: all the money goes back | `rule3_wrong_amount_or_hash_or_token_returns_everything` | `short amount, extra amount and wrong hash are each refunded in full` |
| Sent + refunded + queued always equals the batch total | `rule4_buckets_always_add_up_through_failure_and_refund` | `holds for every batch in this sandbox` |
| A split pays out exactly what arrived; unknown splits are refunded | `split_parts_always_add_up_and_never_overflow` | `the contract refunds payments to an unknown split in full` |

## Security model

Nothing Cascade runs can move money anywhere it was not already headed. Details: [docs/threat-model.md](docs/threat-model.md).

- **Custody:** checkout money goes from 1Click to the merchant, its DAO or its split, never to Cascade. The app contract is deployed **locked** (no access keys) and has no admin withdrawal.
- **Who can move money:** an owner (its own batches and refunds), a DAO (after its vote), and the contract (only to locked lines, split shares, escrow parties and allowance payees).
- **Keys:** merchant API keys are stored hashed. Changing the payout destination needs the merchant's NEP-413 signature. The dashboard signs with the merchant's own wallet.
- **Webhooks:** HMAC-SHA256 with a timestamp. An x402 payment unlocks one response for one URL, and replays are refused.
- **Relayer:** pays gas only for an allowlist of calls, with rate limits. It cannot change what users signed.
- **Settler:** trusted to report what 1Click delivered. It only writes records, each deposit address once.

## Repository layout

```
contracts/      app (receipts, batches, splits, escrow, allowances), factory, Rust tests, prebuilt wasm (res/)
packages/       core · db (store: SQLite, D1, memory) · engine (checkout, billing, refunds, x402)
                near · oneclick · sputnik · sdk (public SDK, 0 deps) · mcp (MCP server)
services/       api (/v1) · relayer · settler · platform (composition) · worker (Cloudflare) · server (Node)
apps/web/       Next.js static export: landing, checkout, receipt, invoice, shop, POS, dashboard, start, developers
scripts/        demo, local sandbox, deploy, mainnet tests (spike), Cloudflare config, e2e
docs/           architecture, threat model, research, spikes, runbooks, MCP, demo brief, media
deployments/    contract ids per network, mainnet test records
```

## Deploy and host

One deployment serves the pages, the API (`/v1`), the relayer, the demo shop and the settler. On Cloudflare this is one Worker with D1 and a cron trigger, on the free plan. The same code also runs as a Node process or in Docker.

```sh
pnpm deploy:cascade                                   # contracts; every transaction needs a typed "yes"
pnpm cf:configure --url https://<host> --database-id <id>
pnpm cf:deploy
```

Keys live only in `.env` (git-ignored); [`.env.example`](.env.example) lists every setting. Step-by-step guides: [docs/mainnet-runbook.md](docs/mainnet-runbook.md) and [docs/hosting.md](docs/hosting.md).

## Status and limits

- **Network.** The public app runs on NEAR testnet, so swaps there are simulated. Mainnet 1Click payments in both directions are verified. Deploying the contracts on mainnet locks about 15-20 NEAR of storage, and should follow an audit.
- **Not yet verified on mainnet:**
  - delivery into a revenue split through `customRecipientMsg`,
  - private payouts (Confidential Intents),
  - the full Cascade fee: 1Click currently keeps half of it, with or without our key (`pnpm spike feecheck`).
- **Wallets.** Payers on Solana and NEAR pay by QR or deposit address. The one-click wallet button covers EVM wallets.
- **Live accounts.** Live access is by application and manual review.

## Documentation

- [docs/api.md](docs/api.md): every HTTP route, with auth, bodies, limits and webhook events
- [docs/contracts.md](docs/contracts.md): every contract method, who may call it, state diagrams, events
- [docs/architecture.md](docs/architecture.md): money flow, owners, repository map, design decisions
- [docs/threat-model.md](docs/threat-model.md)
- [docs/research.md](docs/research.md): 1Click, x402 and NEAR facts verified, with gotchas
- [docs/spikes.md](docs/spikes.md): mainnet tests and results
- [docs/mainnet-runbook.md](docs/mainnet-runbook.md) · [docs/hosting.md](docs/hosting.md) · [docs/mcp.md](docs/mcp.md)
- [docs/upstream-reports.md](docs/upstream-reports.md): issues found in Sputnik DAO, near-sdk and 1Click, with reproductions
- [docs/demo-script.md](docs/demo-script.md): demo video brief
- [HACKATHON.md](HACKATHON.md): tracks, submission summary, libraries

## License

MIT, see [LICENSE](LICENSE).
