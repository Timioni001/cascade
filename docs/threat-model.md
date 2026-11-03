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

## Cross-chain lines

- A line pays a 1Click deposit address fixed at batch creation. If the quote expires, the contract refuses to pay it and the money goes back to the owner.
- If 1Click fails to deliver after being paid, it refunds to `refundTo`, which is the owner. Cascade does not hold or route that refund.
- We trust 1Click and NEAR Intents to deliver what they quoted. Each quote response carries 1Click's signature, which we store.

## Private payments

A private line asks 1Click for `confidentiality: "basic"` (needs our partner JWT). The NEAR-side transfer from Cascade to the deposit address is still a public `ft_transfer`, so the amount is visible on NEAR; what Confidential Intents hides is the swap and delivery side. We do not claim more until the mainnet spike (docs/spikes.md) shows what is and is not visible.

## Known gaps (to fix before mainnet use)

- Contract storage for invoices and batches is paid by the contract; bounded by the relayer limits and `MAX_LINES`, not by a per-owner deposit.
- No upgrade or pause on the app contract yet. Changing it means redeploying.
- The in-memory rate limiter is per process.
