# Mainnet spikes (not run yet: each one needs the human's approval)

NEAR Intents has no testnet, so a few questions can only be answered on mainnet. Each spike uses about $1, separate dev accounts, keys only in `.env`, a dry quote first, and runs only after an explicit "yes" for that transaction.

| # | Question | How | Cost | Status |
| --- | --- | --- | --- | --- |
| 1 | Incoming: does an `EXACT_OUTPUT` quote deliver exactly N USDC to a NEAR account, and what does `/v0/status` return at each step? | Dry quote, real quote, send ~$1 of USDC on Base to the deposit address, `deposit/submit`, poll status | ~$1 + gas on Base | not run |
| 2 | Expired quote: what happens to a deposit sent after the deadline? | Real quote with a short deadline, wait, send $1 | ~$1 | not run |
| 3 | Outgoing: does an `ft_transfer` of USDC from a NEAR account to a 1Click deposit address (implicit account) need a storage deposit first? | `storage_balance_of(deposit address)`, then transfer $1 | $1 + 0.00125 NEAR | not run |
| 4 | Factory: create one name under our root account with the factory contract | Deploy factory, `create_name` once | ~0.05 NEAR | not run (needs the root account, which only the human can create) |
| 5 | Relayer: one fee-free `register_owner` through our relayer | Deploy app, relay one delegate action | gas only | not run |
| 6 | Private payment: with a partner JWT, request `confidentiality: "basic"` for USDC NEAR -> USDC Base and send $1. What is visible on NEAR and on Base? | Needs the JWT | ~$1 | not run, needs JWT |

Write results here as they come in, with transaction links.
