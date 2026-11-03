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
  app/          Rust. Owners, invoices, batches, lines. model.rs is a pure state machine; lib.rs binds it to NEAR.
  factory/      Rust. Creates name.<factory> accounts. Relayer-only, daily cap.
  mock-usdc/    Rust. Sandbox-only NEP-141 with a freeze list (real USDC can freeze).
  res/          Prebuilt wasm (ours and the real Sputnik v2 from mainnet).
  tests/        Sandbox tests: safety rules against real receipts.
packages/
  core/         Domain types, money (bigint), line hash (Borsh + SHA-256, shared vector with Rust), names, chains.
  oneclick/     1Click client (from the OpenAPI spec), Cascade's quoting rules, MockOneClick.
  sputnik/      Payroll policy, register/fund proposals, funding-proposal verifier.
  near/         `Call` builders, Chain wrapper, NEP-366 sign/decode.
  db/           Store interface (memory, node:sqlite), accountant CSV.
  engine/       Use cases (invoice, quote for payer, batch, fund, propose) behind an Executor; checkout.ts: merchants, sessions, webhooks.
  sdk/          Public, dependency-free: server client, webhook verify, Pay button/modal, EVM payments.
services/
  relayer/      Pays gas for allowed calls (NEP-366) and creates names. Policy + rate limits.
  settler/      Crank: records 1Click deliveries, executes batches, refunds failures, tracks cross-chain lines; hooks for checkout.
  api/          Checkout API (Hono): /v1/merchants, /v1/checkout/sessions, /v1/public/*.
apps/
  web/          Next.js 15: hosted checkout /c/[id] (also the iframe target) and a demo shop /shop.
scripts/
  sandbox/      Local node, deployment ("world") and the two stories ("flows").
  demo-sandbox.ts   pnpm demo
```

Planned, not built yet: dashboards (invoices, batches, approvals), Solana/NEAR wallet buttons in checkout, `scripts/demo-mainnet.ts`. Cut: the AI assistant.

## Checkout flow

```
merchant server ──sk_ key──▶ POST /v1/checkout/sessions ──▶ session (cs_…, url)
customer ──▶ /c/cs_… (modal iframe via @cascade/sdk) ──▶ preview (dry quote) ──▶ pay (real quote, recipient = merchant)
customer wallet ──any coin, any chain──▶ 1Click deposit address ──NEAR Intents──▶ USDC to merchant (account or DAO)
settler ──/v0/status SUCCESS──▶ record_link_payment(receipt hash = session) ──▶ signed webhook to merchant server
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
