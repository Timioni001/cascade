# API reference

One deployment serves every route below on one origin (Cloudflare Worker or Node). Source: `services/api/src/app.ts` (`/v1`), `services/platform/src/*.ts` (`/api`, `/health`), `services/relayer/src/server.ts` (`/relayer`).

## Conventions

| | |
| --- | --- |
| **Amounts** | Strings of **USDC base units** (6 decimals): `"25000000"` is $25.00. The SDK (`@cascade/sdk/server`) accepts `"25.00"` and converts |
| **Auth** | `Authorization: Bearer sk_…` (full access) or `rk_…` (read-only: GET routes only; any other method returns 403). Keys are stored as SHA-256 hashes |
| **Errors** | `{"error": {"message": "…"}}` with the HTTP status: 400 invalid input, 401 bad or revoked key, 403 read-only key on a write, 404 not found, 409 conflict, 429 rate limited |
| **Idempotency** | `Idempotency-Key` header on `POST /v1/checkout/sessions`: the same key returns the same session |
| **Webhooks** | `POST` to the merchant's URL with header `Cascade-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Retried with backoff up to 8 attempts. Verify with `verifyWebhook` from `@cascade/sdk/webhooks` |

## Rate limits

| Scope | Limit |
| --- | --- |
| Merchant onboarding (`POST /v1/merchants`) | 10 per hour per IP |
| Checkout session creation | 1,000 per hour per merchant |
| Public checkout routes (`/v1/public/*`) | 600 per hour per IP |
| Sandbox accounts (`POST /api/sandbox/merchant`) | 3 per day per IP |
| Live-access applications (`POST /api/apply`) | 10 per day per IP |
| Admin (`/api/admin/*`) | 10 wrong tokens per hour per IP |

## Merchant API (`/v1`, secret key)

### Account

| Method | Path | Does |
| --- | --- | --- |
| POST | `/v1/merchants` | Onboard: `{account, name, webhookUrl?, proof}`, where `proof` is a NEP-413 signature of `onboardingMessage(...)` by `account` (or by a preparer its DAO approved). Returns the secret key and webhook secret once. No auth |
| GET | `/v1/merchant` | The merchant: id, name, NEAR account, webhook URL, payout destination |
| POST | `/v1/merchant` | Update `name`, `webhookUrl` |
| GET | `/v1/merchant/balance` | USDC balance of the merchant's NEAR account (read from the chain) |
| POST | `/v1/merchant/payout` | Change where payments settle: `{payout: {chain, address} \| null, proof}`. `chain` is one of `near`, `eth`, `base`, `arb`, `sol`; `proof` is a NEP-413 signature of `payoutMessage(...)` by the merchant's account |
| GET / POST | `/v1/merchant/keys` | List keys; create `{role: "full" \| "read", label?}` (the key is shown once) |
| POST | `/v1/merchant/keys/:prefix/revoke` | Revoke a key. A key cannot revoke itself, so a merchant cannot lock itself out |

### Checkout

| Method | Path | Does |
| --- | --- | --- |
| POST | `/v1/checkout/sessions` | `{amount, description, reference?, metadata?, successUrl?, cancelUrl?, expiresInMinutes? (5-1440, default 60), splitId?, escrowId?}`. Max $100,000. Returns the session with its hosted `url` |
| GET | `/v1/checkout/sessions?limit=` | Newest first |
| GET | `/v1/checkout/sessions/:id` | One session, with attempts and the on-chain receipt id once paid |
| POST | `/v1/checkout/sessions/:id/refunds` | `{amount?}` (default: all). Returns the refund and the two NEAR calls the merchant signs (create the hash-locked batch line, fund it) |
| POST | `/v1/refunds/:id/confirm` | After signing: Cascade watches the line and sends `refund.succeeded` or `refund.failed` |
| GET | `/v1/refunds/:id` | Refund status |

### Billing

| Method | Path | Does |
| --- | --- | --- |
| POST / GET | `/v1/invoices` | Create `{customer: {name, email?}, items: [{description, quantity, unitAmount}], dueDate? \| daysUntilDue?, memo?}`; list. Numbered `INV-0001`…, hosted at `/i/<id>` |
| GET | `/v1/invoices/:id` | One invoice |
| POST | `/v1/invoices/:id/void` | Void an open invoice |
| POST / GET | `/v1/plans` | Create `{name, amount, interval: day \| week \| month \| year}`; list |
| POST / GET | `/v1/subscriptions` | Create `{planId, customer, prepaidPeriods? (0-12)}`; list. Renewal invoices are issued before each period; unpaid ones go `past_due`, then `canceled` |
| GET | `/v1/subscriptions/:id` | One subscription |
| POST | `/v1/subscriptions/:id/cancel` | `{atPeriodEnd?}`: cancel now, or at the end of the paid period |
| GET | `/v1/customers` | Customers aggregated across invoices and subscriptions |

### Money out (read from the contract)

| Method | Path | Does |
| --- | --- | --- |
| GET | `/v1/merchant/payouts` | Payout batches the merchant's account owns, with recipients and status |
| GET | `/v1/merchant/escrows` | Escrows where the merchant is payee or payer (`get_escrows_for`) |
| GET | `/v1/merchant/agents` | Agent allowances the merchant has set (`get_allowances`) |

### Agents (x402)

| Method | Path | Does |
| --- | --- | --- |
| POST | `/v1/x402/prepare` | `{amount, description, resource, url, mimeType?, assets?, refundTo?}` → the `402 Payment Required` body: payment options in any coin (1Click deposit addresses) and NEAR-direct via `agent_pay` |
| POST | `/v1/x402/settle` | `{payload, resource}` → verifies the payment (1Click status, or the contract's `agent_paid` event) and returns the `PAYMENT-RESPONSE`. One payment unlocks one response for one resource |

`x402Guard` from `@cascade/sdk/x402` wraps both calls for a route handler.

### Webhooks and reports

| Method | Path | Does |
| --- | --- | --- |
| GET | `/v1/webhooks` | Delivery log, with attempts and status |
| POST | `/v1/webhooks/:id/retry` | Send again now |
| GET | `/v1/reports/ledger.csv?month=YYYY-MM` | Accountant CSV: every payment, refund and fee with its NEAR receipt |

Webhook events: `checkout.session.completed`, `checkout.session.expired`, `checkout.payment.refunded`, `refund.succeeded`, `refund.failed`, `invoice.created`, `invoice.paid`, `invoice.overdue`, `invoice.voided`, `subscription.activated`, `subscription.renewed`, `subscription.past_due`, `subscription.canceled`.

## Public checkout (`/v1/public`, no auth, CORS open)

Used by the hosted checkout, invoice and receipt pages.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/v1/public/assets` | Coins and chains customers can pay with |
| GET | `/v1/public/sessions/:id` | What the customer sees: merchant, amount, description, status |
| POST | `/v1/public/sessions/:id/preview` | `{assetId}` (1Click asset id) → dry `EXACT_OUTPUT` quote: how much of that coin, fee included |
| POST | `/v1/public/sessions/:id/pay` | `{assetId, refundTo}` → a real quote with a one-time deposit address and deadline |
| POST | `/v1/public/sessions/:id/deposit` | `{txHash}` → tells 1Click about the deposit to speed it up |
| GET | `/v1/public/sessions/:id/receipt` | The receipt with its four checks, recomputed from the chain and 1Click on each call |
| GET | `/v1/public/invoices/:id` | A hosted invoice |
| POST | `/v1/public/invoices/:id/pay` | Opens a checkout session for the invoice |
| POST | `/v1/public/dev/sessions/:id/simulate-deposit` | **Testnet demo only** (`CASCADE_ONECLICK=mock`): simulates the customer's deposit |

## Platform (`/api`, `/health`, `/relayer`)

| Method | Path | Does |
| --- | --- | --- |
| GET | `/health` | `{ok, network, app, usdc, oneclick: "live" \| "simulated"}` |
| GET | `/api/sandbox` | `{available}`: whether sandbox accounts can be created here |
| POST | `/api/sandbox/merchant` | `{name}` → a real testnet NEAR account from the factory, registered gas-free and onboarded with its own NEP-413 signature. Returns `secretKey` and the account's key. Testnet demo only |
| POST | `/api/apply` | Live-access application: `{company, email, useCase, website?, country?, monthlyVolume?, nearAccount?}` |
| GET | `/api/admin/overview` | Operator view: stats, applications, merchants. `Authorization: Bearer <CASCADE_ADMIN_TOKEN>`; 404 when the token is unset |
| POST | `/relayer/relay` | A signed NEP-366 delegate action, relayed if the call is on the allowlist (gas paid by Cascade) |
| POST | `/relayer/names` | `{name, publicKey}` → creates `<name>.<root>` through the factory |
| POST | `/api/shop/session`, GET `/api/shop/order`, POST `/api/shop/webhook`, GET `/api/shop/forecast` | The built-in demo shop and its x402-paid forecast API, acting as an ordinary merchant |
