# Mainnet spikes

Each spike needs the human's approval and runs from their machine.

Scripts: `pnpm spike <name>` (see [mainnet-runbook.md](mainnet-runbook.md)). Results land in `deployments/<network>-spikes.json`.

NEAR Intents has no testnet, so a few questions can only be answered on mainnet. Each spike uses about $1, separate dev accounts, keys only in `.env`, a dry quote first, and runs only after an explicit "yes" for that transaction.

| # | Question | How | Cost | Status |
| --- | --- | --- | --- | --- |
| 1 | Incoming: does an `EXACT_OUTPUT` quote deliver exactly N USDC to a NEAR account, and what does `/v0/status` return at each step? | Dry quote, real quote, send ~$1 of USDC on Base to the deposit address, `deposit/submit`, poll status | ~$1 + gas on Base | **done 2026-11-06:** SUCCESS, 1.004745 USDC on Base in, exactly 1.00 out on NEAR ([Base](https://basescan.org/tx/0xd96897cadd46d529d3146471b791d70950f6299857a349f243db1e3e58505edf), [NEAR](https://nearblocks.io/txns/FLf4dvUSLR2dEeJTHZXknjSybuipCbSpgSBU4sDqPKr8)) |
| 2 | Expired quote: what happens to a deposit sent after the deadline? | Real quote with a short deadline, wait, send $1 | ~$1 | not run |
| 3 | Outgoing: does an `ft_transfer` of USDC from a NEAR account to a 1Click deposit address (implicit account) need a storage deposit first? | `storage_balance_of(deposit address)`, then transfer $1 | $1 + 0.00125 NEAR | **done 2026-11-06:** SUCCESS, no storage registration was needed; 1.00 in, 0.997398 out on Base ([NEAR](https://nearblocks.io/txns/AfevEhJpLCiPBnt5WumWi7nj8CMBvTFxsyXXZqLrLkcL), [Base](https://basescan.org/tx/0x08672264184dedbf01082aa96551f58647074078fc8c3216f132a5dad672992b)) |
| 4 | Factory: create one name under our root account with the factory contract | Deploy factory, `create_name` once | ~0.05 NEAR | not run (needs the root account, which only the human can create) |
| 5 | Relayer: one fee-free `register_owner` through our relayer | Deploy app, relay one delegate action | gas only | not run |
| 6 | Private payment: with a partner JWT, request `confidentiality: "basic"` for USDC NEAR -> USDC Base and send $1. What is visible on NEAR and on Base? | Needs the JWT | ~$1 | not run, needs JWT |
| 7 | Revenue split: does 1Click deliver with `customRecipientMsg` so the payment becomes a split batch? | `pnpm spike split --refund-to <addr>` after `name` and `relay` | ~$1 | not run |
| 8 | Fee: with the partner JWT, does our `appFees` (50 bps) pass through in full? | `pnpm spike feecheck` (dry quotes, nothing sent) | $0 | **done 2026-11-07:** no. With and without the JWT, 1Click returns 25 bps to us and 25 bps to its own account; a $100 EXACT_OUTPUT quote costs the payer 101.527033 USDC on Base either way. Net Cascade fee today: 0.25%. Partner terms to be requested from the 1Click team |

Write results here as they come in, with transaction links.
