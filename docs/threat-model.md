# Threat model

Short version: our servers can delay things and can record a payment that did not happen, but they cannot move anyone's money anywhere it was not already headed.

## Who can move money

| Actor | Can | Cannot |
| --- | --- | --- |
| Person (owner) | Fund their own batch; their USDC goes only to the lines they locked | Fund someone else's batch (the contract returns the tokens) |
| Team (DAO) | Fund its batch after its own vote threshold | Be funded by a member acting alone |
| Preparer (team member) | Create invoices and batches for the team | Fund the team's batch, or change lines after creation (the hash is locked) |
| Anyone | Call `execute_batch` and `refund_failed` | Change where money goes, or pay a line twice |
| Cascade app contract | Pay locked lines; refund failed lines to the owner | Send anywhere else. There is no admin withdrawal |

## The settler (trusted, limited)

The settler account is the only one that can call `mark_invoice_paid` and `record_link_payment`. It reports what 1Click delivered.

- **Trust:** an invoice's Paid status is only as true as the settler's reading of 1Click's `/v0/status`. A compromised settler could mark an unpaid invoice Paid. It **cannot move any money**: these calls only write records.
- **Limits:** each 1Click deposit address can be recorded once; `mark_invoice_paid` refuses an amount below the invoice; the deposit address and destination transaction are stored on-chain so anyone can check them against 1Click and the chain.
- The settler also cranks `execute_batch` and `refund_failed`, which anyone could call.

## The relayer (pays gas, cannot redirect)

The relayer submits NEP-366 delegate actions. NEAR verifies the user's signature and nonce, so the relayer cannot change what is called, the arguments, or the deposit.

- **Allowlist:** only function calls; app methods a user may call (not settler methods); `usdc.ft_transfer_call` only into Cascade with exactly 1 yoctoNEAR; `add_proposal`/`act_proposal` on registered DAOs with no bond; for a DAO not yet registered, only its own registration proposal and votes on it (checked against the stored proposal, not the vote's arguments: see docs/research.md).
- **Abuse:** per-account and per-IP limits; names are limited per IP and per day on-chain; optional human check on sign-up.
- **Worst case if compromised:** it can stop relaying (users can still sign and pay gas themselves), and it can burn its own NEAR. It holds no user funds.

## The factory

Only the relayer can create names. Daily cap on-chain. Each name gets 0.01 NEAR and a USDC registration from the factory's balance; that is the cost of abuse we accept, bounded by the cap.

## Keys in the browser

New users get a full-access key generated in their browser, plus a function-call key limited to the app contract for everyday actions.

- If the browser storage is lost, so is the account. After the first payment the app must ask the user to back up the key (not built yet: web app).
- Malicious code in the web app (supply chain, XSS) could use the full key. Mitigations planned for the web app: a strict CSP, no third-party scripts on signing pages, and signing every funding action only after showing the lines.
- People who already have a NEAR wallet connect it instead (NEAR Connect) and keep their own keys.

## Checkout (merchant API)

- **Custody:** none. A checkout quote's recipient is the merchant's own account or DAO; the customer's refunds go to the customer's own address. Cascade's servers and contract never hold checkout funds.
- **Onboarding:** a merchant proves control of the receiving account with an NEP-413 signature verified against that account's on-chain keys (or a DAO preparer's keys, for a DAO). Proofs expire after 10 minutes and nonces cannot be reused. This stops someone from creating a merchant that "receives" into an account they do not control, which would let them show a victim's name on a checkout page.
- **Secret keys:** shown once, stored as SHA-256 hashes. Merchant routes accept only secret keys and have no CORS, so browsers cannot call them.
- **Session ids** (`cs_` + 18 random base62 chars, ~107 bits) are capabilities for the public checkout page. Knowing one lets you see and pay that session, nothing else.
- **Webhooks:** `Cascade-Signature: t=..,v1=HMAC-SHA256(secret, t.body)`, 5-minute tolerance, constant-time compare in the SDK. URLs must be https (http only for localhost). Retries with exponential backoff, 8 attempts. A merchant must treat the webhook, not the browser redirect, as proof of payment; the demo shop does exactly that.
- **Receipts:** each paid session gets an on-chain receipt whose hash binds session id, merchant, amount and reference, written by the settler (same trust as invoices).
- **Embedding:** the checkout iframe posts messages only to the origin that opened it; the SDK accepts messages only from the Cascade origin, from that iframe, for that session. Everything except `/c/*` sends `X-Frame-Options: DENY`.
- **Gap:** API rate limits and the NEP-413 nonce set are in-memory (one process).

## Revenue splits

- **Custody:** a split payment is held by the app contract only between arrival and payout. On arrival the contract creates a batch that is already funded, with the shares fixed when the split was created (splits are immutable); anyone, normally the settler, can push it out. Parts always add up to the payment (tested exhaustively, including the largest u128).
- **Who can create a split:** the owner or one of its preparers. A preparer of a DAO could therefore create a split for the DAO that pays the preparer. Mitigation: a checkout session can only use a split whose owner is the merchant, and the shares are shown on the checkout page; a DAO that does not want this should not name preparers it does not trust. To consider: splits for a DAO owner created only through a DAO proposal.
- **Dependency on 1Click's `customRecipientMsg`** (marked HIGHLY EXPERIMENTAL by 1Click): if 1Click delivered with a plain transfer instead, the USDC would sit in the app contract with no split attached and no way to attribute it. The contract never bounces a valid split payment (that refund would go back into Intents), and unknown split ids are refunded in full. Split sessions must stay off on mainnet until spike `split` passes.
- **Dust:** payments below 0.01 USDC are refused so they cannot fill storage.

## Refunds

- A refund needs two signatures from the merchant's own key (`create_batch`, then the funding `ft_transfer_call`). Cascade prepares the line, but cannot send a refund, change its destination or its amount: the destination is the customer's own refund address from the original quote, hash-locked in the batch, and the API checks the on-chain batch (owner and hash) before handing out the funding call.
- Total refunds per session cannot exceed what was paid (failed refunds do not count).
- An x402 payment made without a refund address cannot be refunded by this flow (its 1Click refunds go to the merchant's Intents account instead).

## Agent payments (x402)

- Each 402 creates a session bound to `"METHOD url"`; a payment for one resource cannot unlock another (`resource_mismatch`), and a paid session unlocks exactly one response (`already_used` on replay; an in-process lock prevents two concurrent requests both succeeding).
- The agent's `txHash` is only a hint to 1Click; success is decided by 1Click delivering to the merchant and the settler recording it, never by the client's claim.
- 402 responses reserve real deposit addresses (up to 3 per request). A client spamming unpaid requests costs quote calls, bounded by the API's rate limits.
- One success per session is an atomic claim in the store (`claimOnce`), so it also holds across Worker isolates.
- **Paying from an allowance (NEAR):** success needs an `agent_payment` event emitted by the Cascade app contract itself, read from the receipts that contract executed in that transaction (logs are attributed to the executing account, so another contract in the same transaction cannot forge one), to this merchant, for at least the price, with the session's memo. The event is emitted only in the callback after the transfer succeeded. Each transaction hash is used once.

## Escrow

- The contract holds escrowed USDC between funding and each milestone's release or refund. Destinations are fixed at creation: releases only go to the payee, refunds only to the payer.
- Only the payer, or the arbiter named at creation, can release. The payee or the arbiter can refund at any time; anyone can return unreleased milestones after `refund_after_ms` (1 hour to 1 year), so the payer is never stuck with money locked forever. A payee who needs protection against a payer who never releases should name an arbiter.
- Funding must be exactly the total, once (anything else is returned in full). A checkout session can fund an escrow only if its payee is the merchant; only one open session per escrow, and the escrow is re-checked on-chain before a deposit address is issued, because a second delivery would be bounced back into 1Click.
- A failed transfer puts the milestone back to Pending; the money stays in the contract.

## Agent allowances

- An agent can only call `agent_pay` for its own (owner, agent) allowance, and the contract checks every rule before money moves: not revoked, not expired, per-payment limit, rolling UTC-day limit, balance, allowed recipients. A failed transfer gives back the balance and the day's room.
- Only the owner tops up its own allowance (`ft_transfer_call` from the owner; anyone else's is returned). The owner can change limits or revoke at once; revoking returns the balance to the owner.
- A compromised agent key can spend at most the daily limit per day, only to allowed recipients if a list is set, until revoked.

## Payout destination

- Changing where checkout money settles (USDC on another chain, or another address) needs a fresh NEP-413 signature from the merchant's NEAR account (or a DAO preparer), with a single-use nonce, not just the secret key. Open sessions keep the destination they were created with; the destination is bound into the on-chain receipt hash.
- With a non-NEAR payout, Cascade cannot check the delivery on-chain itself; it relies on 1Click's status (as for any cross-chain delivery) and still records a receipt on NEAR.

## API keys

- Only key hashes are stored. Read-only keys (`rk_…`) can only make GET requests; they cannot create, refund, issue keys or change settings. A key cannot revoke itself.

## Fees

The optional Cascade fee is a 1Click `appFees` entry paid by the customer on top of the price; the checkout page discloses it and the merchant still receives the exact amount. Without a partner JWT, 1Click keeps half of it (observed with dry quotes).

## Merchant dashboard

The dashboard keeps the key in the browser tab's session storage and calls the API on the same origin. A script injected into the dashboard page could read the key while it is open: the dashboard loads no third-party scripts. Use a read-only key for anyone who only needs to look; keys can be revoked from Settings.

## Cross-chain lines

- A line pays a 1Click deposit address fixed at batch creation. If the quote expires, the contract refuses to pay it and the money goes back to the owner.
- If 1Click fails to deliver after being paid, it refunds to `refundTo`, which is the owner. Cascade does not hold or route that refund.
- We trust 1Click and NEAR Intents to deliver what they quoted. Each quote response carries 1Click's signature, which we store.

## Private payments

A private line asks 1Click for `confidentiality: "basic"` (needs our partner JWT). The NEAR-side transfer from Cascade to the deposit address is still a public `ft_transfer`, so the amount is visible on NEAR; what Confidential Intents hides is the swap and delivery side. We do not claim more until the mainnet spike (docs/spikes.md) shows what is and is not visible.

## Known gaps (to fix before mainnet use)

- Contract storage for invoices, batches, escrows and allowances is paid by the contract; bounded by the relayer limits, `MAX_LINES` and `MAX_MILESTONES`, not by a per-owner deposit.
- The app contract is deployed locked (no access keys; `deployments/<network>.json` records `appLocked: true`). Nobody can upgrade or pause it; a new version means a new app account. The factory lives on the root account, which keeps a key: it holds only NEAR for creating names, never user funds.
- Rate limits and replay guards are in the database (D1 or SQLite), shared by every instance.
