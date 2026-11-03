# Cascade

Get paid in crypto from any blockchain and receive US dollars. Send, split and run team payroll with no fees for your users. Built on NEAR.

A freelancer in Lagos with a client in Berlin has two bad options today: a bank transfer that takes days and loses a lot to fees and exchange rates, or crypto, which means asking the client to use a particular coin on a particular chain, buying gas tokens, and handling seed phrases. Cascade lets her send one link. The client pays with whatever coin they hold on whatever chain; she receives US dollars (USDC) in an account named `ada.cascade.near`, never sees a seed phrase and never pays a network fee. She can then pay rent, family or a team in USDC on whatever chain each of them uses. A team does the same from its Sputnik DAO: payroll becomes one proposal, members approve it without fees, and the DAO keeps custody throughout.

> **Status (2026-11-03):** contracts, services and both end-to-end flows work on a local NEAR sandbox and are tested. Nothing is deployed to mainnet yet, and the web app is not built yet. See [What works today](#what-works-today).

## Try it in one command

Requirements: Node 22.13+, pnpm 10, internet access (the first run downloads the NEAR sandbox node, ~90 MB). No keys, no money, no Rust.

```sh
pnpm i
pnpm demo
```

What you will see (about 40 seconds):

1. A local NEAR node starts (nearcore 2.14.0, the version mainnet runs) and the contracts deploy: Cascade app, name factory, the real Sputnik DAO v2 code copied from mainnet, and a mock USDC.
2. **Ada signs up** and gets `ada.cascade.sandbox` from the factory. Her NEAR balance is paid by Cascade.
3. **Ada invoices** her Berlin client for $300. The invoice is on-chain as Open; only a hash of the details is public.
4. **The client pays in ETH on Base.** A dry quote shows the price, a real quote gives a one-time deposit address, the (mock) 1Click delivers USDC, and the settler marks the invoice Paid on-chain.
5. **Someone pays her public link with SOL.** It is recorded as an on-chain receipt.
6. **Ada splits** $200: rent to a Solana address, a private payment to her sister on Base, $30 to a friend on NEAR. One batch, one signature, every line Sent.
7. **Ada's studio is a Sputnik DAO** (finance: Ada; approvers: Bola, Chidi, Dami; 2 of 3). It joins Cascade through its own proposal.
8. A client pays the studio's $1,500 invoice from Arbitrum; the USDC lands in the DAO.
9. Ada prepares payroll for four people on three chains. She **cannot** fund it herself: the contract sends her tokens back.
10. One approval: still unfunded. Two approvals: **the DAO itself funds the batch**.
11. The settler pays the lines in chunks. One recipient's USDC is frozen, so that line fails and **$100 goes back to the DAO** automatically.
12. The accountant's CSV for Ada and for the studio is printed.
13. 14 checks run, including: Ada and the approvers spent **0 NEAR on fees**; every recipient holds exactly its line amount; Sent + Refunded equals each batch total. The command exits non-zero if any check fails.

## Tests

```sh
pnpm test:unit       # 33 TypeScript unit tests (seconds)
pnpm test:sandbox    # 13 tests against a local NEAR node with real receipts (~1 min)
pnpm test            # both
pnpm test:contracts  # 21 Rust unit tests (needs Rust)
```

Each safety rule has a test at the contract level (`contracts/app/src/tests.rs`) and on a real node (`contracts/tests/safety.test.ts`):

| Rule | Unit test | Sandbox test |
| --- | --- | --- |
| No line is paid before its batch is funded | `rule1_no_line_is_paid_before_the_batch_is_funded` | `execute_batch on an unfunded batch fails` |
| No line is ever paid twice | `rule1_no_line_is_ever_paid_twice`, `invariant_holds_under_random_walks` | `two cranks racing in the same block pay each line exactly once` |
| Only a team's DAO can fund the team's batch; only the owner can fund a personal batch | `rule2_*` | `someone else's ft_transfer_call is returned in full`, `a DAO's preparer cannot fund` |
| Wrong amount or hash: all the money goes back | `rule3_wrong_amount_or_hash_or_token_returns_everything` | `short amount, extra amount and wrong hash are each refunded in full` |
| Sent + Refunded + Queued always equals the batch total | `rule4_buckets_always_add_up_through_failure_and_refund` | `holds for every batch in this sandbox` |

## How NEAR is used

| NEAR feature | Where | What it does for the user |
| --- | --- | --- |
| NEAR Intents via the 1Click API | `packages/oneclick`, `packages/engine` | Payer uses any coin on any chain; owner receives exactly the USDC asked for. Outgoing lines reach any chain |
| Confidential Intents | `packages/oneclick/src/intents.ts` (`confidentiality: "basic"`) | Private lines. Needs the 1Click partner JWT; not yet tested on mainnet ([spikes](docs/spikes.md)) |
| Meta-transactions (NEP-366) | `packages/near/src/meta.ts`, `services/relayer` | Users and DAO approvers never pay gas |
| Named accounts | `contracts/factory` | `ada.cascade.near` is the payment address. No seed phrase |
| Function-call access keys | `contracts/factory` (`app_key`) | Everyday actions are signed by a key that can only call Cascade |
| Sputnik DAO v2 | `packages/sputnik`, `scripts/sandbox/flows.ts` | Teams keep custody; payroll is one proposal; members vote fee-free |
| NEP-141 `ft_transfer_call` | `contracts/app` `ft_on_transfer` | Funding a batch is one transfer that the contract checks or returns in full |
| NEAR AI Cloud | not built yet | Planned: draft invoices and payroll from a file or a sentence |

## What works today

| Piece | State |
| --- | --- |
| App contract: owners, invoices, link receipts, batches, chunked payouts, refunds, quote deadlines | Done, unit and sandbox tested |
| Name factory with limited app key and USDC registration | Done, tested |
| 1Click client, Cascade quoting rules, MockOneClick | Done; real API checked with free dry quotes ([research](docs/research.md)) |
| Relayer (NEP-366) with allowlist and rate limits; settler crank | Done, tested; not deployed |
| Accountant CSV | Done |
| Web app (payment link, invoice page, dashboards, "Pay with any crypto" button) | Not started; next |
| SDK (`createPayLink`, `<PayButton/>`) | Not started |
| AI assistant on NEAR AI Cloud | Not started |
| Mainnet deployment and real transactions | Not done; each step needs approval ([spikes](docs/spikes.md)) |

Mainnet transaction links will be listed here once they exist.

## Threat model

Our servers can delay things and the settler can wrongly mark an invoice paid, but nothing we run can move money anywhere it was not already headed. Details: [docs/threat-model.md](docs/threat-model.md).

- **Who can move money:** an owner (their own batches), a DAO (after its vote), and the app contract (only to locked lines, and refunds only to the owner). No admin withdrawal exists.
- **Settler:** trusted to report what 1Click delivered; it only writes records, each deposit address once.
- **Relayer:** pays gas for an allowlist of calls; it cannot change what users signed.
- **Keys in the browser:** a lost browser means a lost account until the user backs up the key; the web app must prompt for that.

## Running the services

```sh
cp .env.example .env   # fill in accounts and keys; never commit .env
pnpm relayer           # POST /relay, POST /names
pnpm settler           # polls 1Click and the contract
```

## Documentation

- [docs/architecture.md](docs/architecture.md): money flow, owners, repository layout, design decisions
- [docs/threat-model.md](docs/threat-model.md)
- [docs/research.md](docs/research.md): hackathon rules, 1Click and NEAR facts we verified, gotchas found
- [docs/spikes.md](docs/spikes.md): the mainnet tests still to run
- [contracts/res/README.md](contracts/res/README.md): where each wasm comes from

## Built at NEAR HACKATHON

Tracks: Real-World Money (`realworld`), Social Money (`social`). See [HACKATHON.md](HACKATHON.md) for the code diff and disclosures.

## License

MIT, see [LICENSE](LICENSE).
