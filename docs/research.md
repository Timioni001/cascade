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
| Code that counts | Tag `pre-hackathon` and `hackathon-submission`, link the diff in the README |
| Disclosures | All libraries, templates and AI-written code in the README. LICENSE file |
| Mainnet | No Intents testnet exists or is planned (Q-007). Use separate dev accounts and tiny amounts |
| Agent rules | Never push, make public, deploy, sign mainnet transactions, post or submit without the human's explicit OK |

The `pre-hackathon` tag is on the repository's initial commit (README only).

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

So private payments need the partner JWT from partners.near-intents.org. `MockOneClick` reproduces all three behaviours.

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

## Open questions (need a decision or a mainnet test)

1. Can Confidential Intents deliver to a public address on another chain while hiding the NEAR-side amount? Our outgoing private line pays a 1Click deposit address with a public `ft_transfer`, so the amount is visible on NEAR; only the destination side is private. See docs/spikes.md.
2. Does a 1Click deposit address on NEAR (an implicit account) need a USDC storage deposit before receiving? We register it in `execute_batch` either way (refunded if not needed).
3. What does 1Click do with a deposit sent after the quote deadline? The contract never pays after the deadline, but a 1Click refund to the owner is the fallback.
