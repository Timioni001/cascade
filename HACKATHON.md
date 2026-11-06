# NEAR HACKATHON disclosures

## Code written during the hackathon

Everything in this repository except the one-line README of the initial commit was written during the hackathon window (2026-10-19 to 2026-11-14).

- Baseline: tag `pre-hackathon` (the initial commit, README only)
- Submission: tag `hackathon-submission` (to be created at submission)
- Diff: https://github.com/timioni001/cascade/compare/pre-hackathon...hackathon-submission

## Tracks

- `realworld` (08, Real-World Money): main track
- `social` (12, Social Money): Sputnik DAO team payroll
- `privacy` (03): only if private payments are shown working on mainnet

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

**Try it:** [cascade.timioni1490.workers.dev](https://cascade.timioni1490.workers.dev): create a sandbox account at `/start`, take a payment at `/pos`, or buy from the demo shop. Locally: `pnpm demo` runs every story above on a NEAR sandbox node with 38 checks.

**What is real and what is simulated on testnet:** contracts, accounts, receipts, escrow, splits, payouts, agent budgets and webhooks are real. The cross-chain swap is simulated because NEAR Intents has no testnet; real 1Click payments are shown separately on mainnet (see the README's Proof section).

**Tracks:** Real-World Money (main): checkout, invoices, point of sale, payroll and settlement for real businesses. Social Money: team payroll approved by a Sputnik DAO, shared revenue splits.

## AI-written code

Most of the code was written by Claude Code (Anthropic) working with the team lead, who directed the design and reviewed it. AI-written: all contracts, packages, services, scripts, tests and docs in this repository.

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
| wrangler (Cloudflare) | 4.151.2 | Builds, runs locally and deploys the Worker (D1, cron) |
| lucide-react | 1.59.0 | Icons |
| Geist, Geist Mono (via next/font) | | Typeface |
| vitest, tsx, typescript | 4.1.12, 4.23.15, 5.9.3 | Tests and tooling |
| Sputnik DAO v2 (wasm) | mainnet code hash 2Zof1Tyy... | Real DAO contract in the sandbox; not modified. See contracts/res/README.md |

No templates or boilerplate were used. The 1Click types were transcribed from its OpenAPI spec; the x402 messages follow the x402 v2 specification (github.com/coinbase/x402).

## Other projects

None. This is the team's only submission.
