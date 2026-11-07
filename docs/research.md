# Research notes

What we checked before and while building, so decisions can be traced. Dates are when we checked.

## The hackathon (read 2026-11-03 from nearhackathon.com/HACKATHON.md)

| Fact | Value |
| --- | --- |
| Build window | 2026-10-19 (announcement) to 2026-11-14 23:59 UTC |
| Repo | Must be public by the deadline. One submission per repo |
| Judging | 2026-11-16 to 11-18. Claude Code and Codex screen first (reproducibility, feature check, structured report); humans decide |
| Tracks we fit | `realworld` (08, main), `social` (12, second), `privacy` (03, only if private payments work on mainnet) |
| Track 08 ask | "Something a normal company could use tomorrow": invoice link payable from any chain via 1Click, USDC on NEAR, gasless via a relayer that only pays for our contract, trusted paid/pending/refunded statuses with tx links, accountant-ready CSV |
| Track 12 ask | Build on Sputnik DAO / Trezu, "don't rebuild the multisig", named accounts |
| Disclosures | All libraries, templates and AI-written code in the README. LICENSE file |
| Mainnet | No Intents testnet exists or is planned (Q-007). Use separate dev accounts and tiny amounts |
| Agent rules | Never push, make public, deploy, sign mainnet transactions, post or submit without the human's explicit OK |


## 1Click API (spec from https://1click.chaindefuser.com/docs/v0/openapi.yaml, 2026-11-03)

- Endpoints we use: `GET /v0/tokens`, `POST /v0/quote`, `GET /v0/status`, `POST /v0/deposit/submit`.
- `QuoteRequest` requires `dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount, refundTo, refundType, recipient, recipientType, deadline`.
- Status values: `KNOWN_DEPOSIT_TX, PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED`.
- **Confidential Intents are in the API**: `confidentiality: public | basic | advanced`, and `CONFIDENTIAL_INTENTS` as a deposit, refund and recipient type.

Live checks (free dry quotes, no money):

| Check | Result |
| --- | --- |
| Dry `EXACT_OUTPUT` quote, ETH on Base -> 5 USDC on NEAR, no JWT | 200. 0.00222 ETH (~$5.07). No deposit address (as documented). Response adds `appFees: [{fee: 20}]`: the 0.2% unauthenticated fee is real |
| Dry quote with `confidentiality: "basic"`, no JWT | 401 "User authentication is required for confidential intent quotes" |
| Dry quote USDC on Base -> 1 USDC on NEAR, no JWT | 200, pay 1.010309 USDC. The unauthenticated `appFees` entry here was **1 bps**, versus 20 bps on ETH -> USDC: the fee depends on the route |
| Dry quote to a NEAR recipient that does not exist | 400 "Internal server error". The same quote to an existing account works, at $1 and $5. Recipients must exist before quoting |
| Dry quote with `customRecipientMsg: {"split":0}` | Accepted and echoed back. Whether it is honoured on delivery is spike `split` |
| Dry quote with our `appFees` of 30 bps, no JWT | Accepted, but 1Click **splits it**: 15 bps to our recipient, 15 bps to its own fee account. Payer pays 1.013247 instead of 1.010309. With a partner JWT the full fee should be ours (to confirm) |
| Dry quote with `refundType: INTENTS`, `refundTo` a NEAR account | Accepted (used for x402 payments when the agent gives no refund address) |

So private payments need the partner JWT from partners.near-intents.org, and so does keeping our whole fee. `MockOneClick` reproduces the behaviours above (except the fee split).

## x402 (agent payments)

- Spec: github.com/coinbase/x402, `specs/x402-specification-v2.md` and `specs/transports-v2/http.md` (read 2026-11-03). v2 uses headers `PAYMENT-REQUIRED` (402, base64 JSON `{x402Version: 2, error, resource, accepts[]}`), `PAYMENT-SIGNATURE` (client, base64 `{x402Version, resource, accepted, payload}`) and `PAYMENT-RESPONSE` (settlement). Networks are CAIP-2 (`eip155:8453`).
- The Ping facilitator that the Track 08 page points to implements x402 v2 with `scheme: "exact"` on `eip155:8453` (Base USDC only), `payTo` = a NEAR Intents deposit address, and `payload.txHash` as the proof, settling to a NEAR recipient through 1Click. Cascade uses the same shape, so x402 clients that can send a tx hash work, and offers any chain 1Click supports (up to 3 options per 402) instead of Base only.
- Cascade binds each 402 to one checkout session and to `"METHOD url"`, and hands out exactly one successful response per payment (`already_used` on replay, `resource_mismatch` for another URL).

Asset ids from `GET /v0/tokens` (215 tokens): USDC on NEAR `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals), ETH on Base `nep141:base.omft.near`, SOL `nep141:sol.omft.near`, USDC on Solana `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`, USDC on Base/Arbitrum/Ethereum in `packages/core/src/chains.ts`.

## NEAR network

- Mainnet runs nearcore **2.14.0**, protocol 86 (RPC `status`, 2026-11-03). The sandbox is pinned to the same version.
- near-sdk **5.30.0** (2026-10-27) builds wasm that imports host functions nearcore 2.14.0 does not have (`Link Error: unknown or invalid import`). We pin **5.29.1**.
- near-sdk 5.29 needs `--cfg near` in RUSTFLAGS to use the host `panic_utf8`; without it, every error message is lost.
- near-api-js **7.4.0** has first-class NEP-366 support: `Account.createSignedMetaTransaction`, `encodeSignedDelegate`, `actions.signedDelegate`.
- `better-near-auth` 1.10 bundles NEP-413 sign-in and a NEP-366 relayer with a static `whitelistedContracts`. Cascade needs a dynamic allowlist (registered DAOs, DAO onboarding, ft_transfer_call only into Cascade), so `services/relayer` has its own policy. We may still use better-near-auth for sign-in in the web app.
- FastAuth and NEAR Lake are deprecated; not used.

## Sputnik DAO v2 (as deployed)

- The code on `devhub.sputnik-dao.near`, `marketing.sputnik-dao.near` and `build.sputnik-dao.near` is identical (hash `2Zof1Tyy...`). We use exactly that wasm in the sandbox.
- Methods we rely on: `add_proposal`, `act_proposal`, `get_proposal`, `get_policy`, `get_last_proposal_id`.
- **Finding:** `act_proposal` accepts a `proposal` argument but does **not** reject a vote whose argument differs from the stored proposal. Anything that inspects votes (our relayer) must read the stored proposal with `get_proposal`. Test: `contracts/tests/safety.test.ts`.
- A `WeightOrRatio` threshold of `"2"` means two approvals. A ratio `[2,3]` with three members needs three (`3*2/3+1`), which is not what "2 of 3" means.

## Gotchas found by running the code

| What broke | Why | Fix |
| --- | --- | --- |
| Every batch funding failed with `unreachable` | The Cascade contract was not registered with the token, so `ft_transfer_call` to it fails | `new()` registers the contract with USDC itself |
| Meta-transaction returned no value and looked successful when the inner call failed | The outer transaction only runs the delegate action | Read result and failure from the target contract's receipts (`parseOutcome(o, target)`) |
| Sandbox would not start in some containers | nearcore requires a 65535 open-file limit; some containers cap it at 20000 | `scripts/sandbox/rlimit-shim.c`, used only when the hard limit is too low |
| A DAO member's limited key could not propose | Function-call keys are bound to one receiver (the app) | DAO calls are signed with the member's full key (still relayed and free). Planned: a per-team limited key |
| Revenue-split payouts were never paid | The contract creates a split's payout batch itself, so the settler (which only tracked batches it created) never saw it | The settler scans new batch ids each tick and adopts funded ones |
| The deploy rehearsal failed with LackBalanceForState | The app contract grew (splits); the fixed 3 NEAR no longer covered its storage | Fund the app from its wasm size (10^19 yocto per byte) plus headroom |
| `pnpm server` silently did nothing | `server` is a built-in pnpm command (its store server) and shadows a script of the same name | The script is `pnpm backend` |
| Next.js could not resolve `./evm.js` inside a workspace package | Webpack does not map ESM `.js` imports onto `.ts` sources | `resolve.extensionAlias` in next.config |

## Open questions (need a decision or a mainnet test)

1. Can Confidential Intents deliver to a public address on another chain while hiding the NEAR-side amount? Our outgoing private line pays a 1Click deposit address with a public `ft_transfer`, so the amount is visible on NEAR; only the destination side is private. See docs/spikes.md.
2. Does a 1Click deposit address on NEAR (an implicit account) need a USDC storage deposit before receiving? We register it in `execute_batch` either way (refunded if not needed).
3. What does 1Click do with a deposit sent after the quote deadline? The contract never pays after the deadline, but a 1Click refund to the owner is the fallback.
4. Does 1Click honour `customRecipientMsg` on delivery (ft_transfer_call with our msg)? Revenue splits depend on it; 1Click calls it HIGHLY EXPERIMENTAL. Spike `split`. If it fails, split sessions must be disabled and splits done by the merchant funding a batch instead.
5. With a partner JWT, is the whole `appFees` share ours (without one, 1Click kept half)?
