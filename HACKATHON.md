# NEAR HACKATHON disclosures

## Tracks

| Track | Official brief | What Cascade ships for it |
| --- | --- | --- |
| `realworld` Real-World Money (main) | "Build payroll, invoicing, remittances, merchant payments and stablecoin rails for real businesses." "Something a normal company could use tomorrow." | Any-coin checkout with exact USDC settlement, point of sale, invoices, subscriptions, refunds, payouts to any chain, settlement on five chains, self-serve sandbox and a developer SDK |
| `social` Social Money | "Build shared budgets, programmable rewards, collective ownership and reputation-based access on top of Sputnik DAO and Trezu." "Don't rebuild the multisig — build what communities do with it." | Team payroll approved by a Sputnik DAO v2 proposal (fee-free votes, a preparer cannot fund alone), revenue splits to members and DAOs on arrival, shared agent budgets with on-chain limits |

## Submission summary

**Cascade** is payment infrastructure on NEAR: businesses, freelancers, teams and AI agents get paid in any coin on any chain and receive exact US dollars (USDC), with the operational tools a business needs around it.

| Area | What it does | Where NEAR is used |
| --- | --- | --- |
| Checkout | Pay button, hosted page, QR, wallet payments, signed webhooks, idempotent sessions | NEAR Intents (1Click) converts any coin; receipts recorded on the Cascade contract |
| Point of sale | Amount on a phone, customer scans and pays in any coin | Same rails as checkout |
| Invoices and subscriptions | Numbered invoices, due dates, reminders, plans, prepaid periods, customers | Every payment is a checkout with an on-chain receipt |
| Settlement choice | Receive USDC on NEAR, Ethereum, Base, Arbitrum or Solana | Changing it needs a NEP-413 signature from the merchant's NEAR account |
| Payouts and payroll | Up to 50 recipients on their own chains in one locked batch; DAO approval | Cascade contract + Sputnik DAO v2; gasless for users (NEP-366) |
| Revenue splits | Divide a sale on arrival (e.g. 80/15/5) | Contract splits on `ft_on_transfer` |
| Milestone escrow | Client funds from any chain; released per milestone on approval | Contract holds funds; only payer or arbiter releases |
| Refunds | Back in the customer's coin and chain | Hash-locked batch line through 1Click |
| AI agents | x402 paywalls; agents pay from budgets with on-chain limits; MCP server for assistants | `agent_pay` allowances with per-payment and daily limits, mandate on every receipt |
| Self-serve access | Instant sandbox accounts, live-access applications, developer portal | Sandbox accounts are real testnet accounts from the Cascade factory |
| Merchant wallet | The dashboard signs escrow releases, agent budgets and payout changes with the merchant's own NEAR wallet | NEAR Connect; NEP-413 and function calls signed by the merchant |

**Try it:** [cascade.timioni1490.workers.dev](https://cascade.timioni1490.workers.dev): create a sandbox account at `/start`, take a payment at `/pos`, or buy from the demo shop. Locally: `pnpm demo` runs every story above on a NEAR sandbox node with 38 checks.

**What is real and what is simulated on testnet:** contracts, accounts, receipts, escrow, splits, payouts, agent budgets and webhooks are real. The cross-chain swap is simulated because NEAR Intents has no testnet; real 1Click payments are shown separately on mainnet (see the README's Proof section).

**Verified on mainnet:** a $1 payment from Base delivered as exactly 1.00 USDC on NEAR, and $1 sent from NEAR to Base, both through 1Click (links in the README's Proof section).

**Not yet verified on mainnet:** revenue-split delivery via `customRecipientMsg`, private payouts, and the full Cascade fee (a dry quote on mainnet shows 1Click keeps half of it, with or without our key).

## Libraries and third-party code

| Name | Version | Use |
| --- | --- | --- |
| near-sdk, near-contract-standards (Rust) | 5.29.1 | Contracts; mock USDC |
| hex (Rust) | 0.4 | Hex encoding in the contract |
| near-api-js | 7.4.0 | RPC, signing, NEP-366 meta-transactions |
| borsh | 2.0.0 | Decoding signed delegate actions |
| @noble/hashes | 2.2.0 | SHA-256 for line and invoice hashes |
| near-sandbox | 0.3.4 | Local NEAR node for demo and tests |
| hono, @hono/node-server | 4.12.34, 2.1.5 | HTTP routing for the platform (Worker and Node server) |
| next, react, react-dom | 15.5.28, 19.1.10 | Web app (static export): checkout, receipts, dashboard, demo shop |
| qrcode | 1.5.4 | QR codes for wallet payment links |
| @hot-labs/near-connect | 0.11.4 | NEAR wallet connector in the dashboard (HOT, Meteor, Intear, MyNearWallet, OKX…): the merchant's own wallet signs escrow releases, agent budgets and payout changes. MIT, loaded only when a signature is needed |
| wrangler (Cloudflare) | 4.151.2 | Builds, runs locally and deploys the Worker (D1, cron) |
| lucide-react | 1.59.0 | Icons |
| Geist, Geist Mono (via next/font) | | Typeface |
| cryptocurrency-icons (SVG files only) | 0.18.1 | Coin logos on the landing page. CC0-1.0 (public domain); eight monochrome SVGs copied into `apps/web/public/coins`, no runtime dependency |
| vitest, tsx, typescript | 4.1.12, 4.23.15, 5.9.3 | Tests and tooling |
| Sputnik DAO v2 (wasm) | mainnet code hash 2Zof1Tyy... | Real DAO contract in the sandbox; not modified. See contracts/res/README.md |

No templates or boilerplate were used. The 1Click types were transcribed from its OpenAPI spec; the x402 messages follow the x402 v2 specification (github.com/coinbase/x402).

## Other projects

None. This is the team's only submission.

## Assisted by Claude

Built with Claude Code (Anthropic) as a coding assistant: it wrote most of the code, tests and docs under my direction. I set the product design, reviewed the work, and ran the deployments and mainnet transactions.
