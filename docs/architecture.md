# Architecture

## Where money can go

Money only moves between three places on NEAR: the **owner** (a person's account, or a team's Sputnik DAO), the **USDC contract**, and the **Cascade app contract**. The app contract holds USDC only between a batch being funded and its lines being paid. Every destination is fixed, and hashed, when the batch is created, before anyone funds it.

```
 payer on any chain ──1Click──▶ USDC ──▶ owner (person or DAO)            money in
                                          │
             owner signs / DAO votes ─────┘ ft_transfer_call(total, {batch_id, hash})
                                          ▼
                                   Cascade app contract ──ft_transfer──▶ NEAR account      money out
                                                         ──ft_transfer──▶ 1Click deposit ──▶ any chain
                                                         ──refund──────▶ owner (failed lines)
```

The contract also holds money in three other cases, each with its destinations fixed up front:

| Held for | Arrives | Leaves |
| --- | --- | --- |
| Revenue split | 1Click delivery with `{"split": id}` | At once, to the split's shares |
| Milestone escrow | `{"escrow": id}`, exact total (from a checkout on any chain, or the payer) | Per milestone: to the payee when the payer (or arbiter) releases; to the payer on refund |
| Agent allowance | `{"allowance": agent}` from the owner | `agent_pay` within the owner's limits, to the allowed recipients; the rest back to the owner on revoke |

Checkout money that needs no contract goes straight from 1Click to the merchant: USDC on NEAR by default, or USDC on Ethereum, Base, Arbitrum or Solana if the merchant signed for it. Invoices and subscriptions are off-chain documents paid through ordinary checkout sessions, so each payment still gets an on-chain receipt.

## Owners

Every invoice and batch belongs to an owner: `Account(id)` or `Dao(id)`. Each feature works for both:

| | Person | Team |
| --- | --- | --- |
| Registers | calls `register_owner` itself (relayed) | its own Sputnik proposal calls `register_owner` |
| Prepares invoices and batches | itself | its `preparers` (set by the DAO) |
| Funds a batch | signs `usdc.ft_transfer_call` | Sputnik `FunctionCall` proposal makes the same call after enough approvals |
| Receives refunds | its account | the DAO treasury |

## Repository

```
contracts/
  app/          Rust. Receipts, payout batches, revenue splits, milestone escrow, agent allowances.
                model.rs and vault.rs are pure state machines; lib.rs binds them to NEAR. Reference: docs/contracts.md
  factory/      Rust. Creates name.<root> accounts with an optional limited app key. Relayer-only, daily cap.
  mock-usdc/    Rust. Sandbox/testnet NEP-141 with a freeze list (real USDC can freeze).
  res/          Prebuilt wasm (ours and the real Sputnik v2 from mainnet) with SHA256SUMS.
  tests/        Tests on a local nearcore node: safety rules against real receipts, the deploy script.
packages/
  core/         Domain types, money (bigint base units), line hash (Borsh + SHA-256, shared vector with Rust), chains, limits.
  oneclick/     1Click client (from the OpenAPI spec), quoting rules, Confidential Intents, MockOneClick for tests and testnet.
  sputnik/      DAO payroll policy, register/fund proposals, funding-proposal verifier.
  near/         Call builders, Chain wrapper, contract reader, NEP-366 sign/decode, event parsing.
  db/           Store interface with three backends: memory, node:sqlite, Cloudflare D1. Accountant CSV.
  engine/       Use cases: checkout (merchants, keys, sessions, receipts, webhooks), billing (invoices, plans,
                subscriptions, customers), refunds, x402 agent payments, payroll batches.
  sdk/          Public, zero-dependency SDK: server client, webhook verification, Pay button/modal, EVM wallet pay, x402.
  mcp/          MCP server: merchant tools (invoices, sessions, reports) and an agent wallet (paid_fetch within an allowance).
services/
  api/          The /v1 REST API (Hono). Reference: docs/api.md
  relayer/      Pays gas for allow-listed calls (NEP-366) and creates names. Policy + rate limits.
  settler/      Crank: records 1Click deliveries, executes batches, refunds failures, renews subscriptions, delivers webhooks.
  platform/     Composition: config, /health, /api (sandbox sign-up, applications, admin, demo shop), in-process routing.
  worker/       Cloudflare Worker entry: static site + platform + cron settler on D1.
  server/       Node entry: the same platform as one process (SQLite), plus Dockerfile.
apps/
  web/          Next.js 15 static export: landing, /c checkout (also the iframe target), /r receipt, /i invoice,
                /shop demo store, /pos point of sale, /dashboard, /start, /developers, /admin (unlinked).
                lib/wallet.ts: NEAR Connect, loaded only when the merchant signs.
scripts/
  sandbox/      Local node, deployment ("world"), seeded stories ("flows", "platform-flow").
  e2e/          Browser tests: checkout.e2e.cjs (the main journeys) and buttons.e2e.cjs (every button and link).
  mainnet/      Deploy (typed "yes" per transaction) and spikes (1Click on mainnet).
  cloudflare/   Configure and deploy the Worker.
  demo-sandbox.ts   pnpm demo
```

Still not built: a one-click Solana or NEAR wallet button inside the customer checkout (those payers use the QR code or the deposit address), and multi-user team logins (teams share keys with roles today).

## Checkout flow

```
merchant server ──sk_ key──▶ POST /v1/checkout/sessions ──▶ session (cs_…, url)
customer ──▶ /c/cs_… (modal iframe via @cascade/sdk) ──▶ preview (dry quote) ──▶ pay (real quote, recipient = merchant)
customer wallet ──any coin, any chain──▶ 1Click deposit address ──NEAR Intents──▶ USDC to merchant (account or DAO)
settler ──/v0/status SUCCESS──▶ record_link_payment(receipt hash = session) ──▶ signed webhook to merchant server
```

Revenue split (session with `splitId`):

```
1Click delivers with customRecipientMsg {"split": id} ──▶ usdc.ft_transfer_call(app, amount, msg)
app.ft_on_transfer ──▶ new batch, already funded, one line per share (parts sum to amount)
settler discovers the batch (scans new batch ids) ──▶ execute_batch ──▶ each share paid
```

Refund:

```
merchant ──sk_──▶ POST /v1/checkout/sessions/:id/refunds ──▶ outgoing quote to the customer's refund address, one hash-locked line
merchant key ──▶ app.create_batch(lines) ──▶ POST /v1/refunds/:id/confirm {batchId} (API checks owner + hash on-chain)
merchant key ──▶ usdc.ft_transfer_call(app, total, {batch_id, hash}) ──▶ settler pays ──▶ 1Click delivers ──▶ webhook refund.succeeded
```

Agent payment (x402 v2):

```
agent ──GET──▶ merchant API ──x402Guard──▶ POST /v1/x402/prepare ──▶ 402 + PAYMENT-REQUIRED (one deposit address per asset)
agent wallet ──pays one option──▶ retries with PAYMENT-SIGNATURE {txHash}
x402Guard ──▶ POST /v1/x402/settle ──▶ payment_pending … until the settler records delivery ──▶ success (once) ──▶ 200 + PAYMENT-RESPONSE
```

## Design decisions

**Calls are data; an Executor sends them.** `packages/near/src/calls.ts` builds `{receiverId, actions}` and never signs. An `Executor` either signs directly (settler, relayer, scripts) or signs a NEP-366 delegate action and hands it to the relayer (every user action). The engine and the tests do not know which.

**One choke point for money state.** Every line move goes through `Batch::transition`, which checks a fixed transition table, refuses anything before funding, moves the amount between six buckets and asserts the buckets still sum to the total. A line in flight cannot be dispatched again, which is what makes concurrent `execute_batch` calls safe.

**Refunds from 1Click go to the owner, not the contract.** Outgoing quotes set `refundTo` to the batch owner. If 1Click cannot deliver, the money lands back with the owner directly, and nothing in our backend has to attribute it. (The original plan sent refunds to the contract; that would have made the settler responsible for routing pooled funds.)

**Quotes have deadlines the contract enforces.** A cross-chain line stores its quote deadline; `execute_batch` marks an expired line Failed instead of paying a dead deposit address, and `refund_failed` returns it to the owner.

**Storage registration happens when paying, not when proposing.** `execute_batch` calls `storage_deposit(registration_only)` before each `ft_transfer`. It costs the contract NEAR only for funded batches (already-registered accounts get the deposit back), so an unfunded draft cannot make Cascade pay storage for arbitrary accounts. The plan had this in `create_batch`.

**Personal data stays off-chain.** An invoice stores only the SHA-256 of its canonical JSON document. The document (client, line items) is in the store.

**The settler is idempotent.** Each deposit address can be recorded once on-chain (`paid_deposits`), and the settler checks `is_deposit_recorded` before writing, so restarts and duplicate settlers are harmless.

## Status values users see

| 1Click | Cascade shows |
| --- | --- |
| `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `INCOMPLETE_DEPOSIT`, `PROCESSING` | Pending |
| `SUCCESS` | Paid |
| `REFUNDED` | Refunded |
| `FAILED` | Failed |
