# Upstream reports (drafts to file)

Problems found while building Cascade that affect other NEAR builders. Each has a reproduction in this repository. They are drafts: the team lead files them (or not) under their own account. Link the filed issues here and in the README.

## 1. Sputnik DAO v2: `act_proposal` does not check its `proposal` argument

**Where:** near-daos/sputnik-dao-contract, the v2 code deployed on mainnet (code hash `2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK`, used by e.g. `devhub.sputnik-dao.near`).

**What happens:** `act_proposal(id, action, proposal, memo)` accepts a vote whose `proposal` argument describes a different proposal kind than the one stored under `id`. The vote is recorded against the stored proposal.

**Why it matters:** the `proposal` argument reads like a safety check (vote only if the proposal is what I think it is). Wallets, relayers and UIs that rely on it to show or filter what a member is voting on can be misled. Cascade's relayer originally relied on it and now reads the stored proposal with `get_proposal` instead.

**Reproduction:** `contracts/tests/safety.test.ts`, test "the DAO accepts a vote that lies about the proposal kind": add a `FunctionCall` proposal that transfers tokens, then call `act_proposal` with `proposal` set to an unrelated kind. The call succeeds and the vote counts.

**Suggested fix:** compare the argument with the stored kind (e.g. by hash) and fail with an explicit error; or document that the argument is not checked.

## 2. near-sdk 5.30.0 builds contracts that cannot be deployed to mainnet (nearcore 2.14.0)

**What happens:** a contract built with near-sdk 5.30.0 imports host functions such as `promise_batch_action_universal_state_init` that nearcore 2.14.0 (mainnet, protocol 86, as of 2026-11-03) does not provide. Calling any method fails with `Link Error: unknown or invalid import`. 5.29.1 works.

**Reproduction:** build any contract with 5.30.0 and `cargo build --target wasm32-unknown-unknown --release`, deploy to a nearcore 2.14.0 sandbox, call a method.

**Suggested fix:** note the minimum protocol version in the 5.30.0 release notes, or gate the new imports behind a feature.

## 3. near-sdk 5.29: without `--cfg near`, every panic message is lost

**What happens:** `env::panic_str` (and so `require!`) only calls the host `panic_utf8` when built with `--cfg near` (cargo-near sets it). A plain `cargo build` produces a contract whose every error is `WebAssembly trap: An unreachable opcode was executed`.

**Suggested fix:** emit a build-time warning when targeting wasm32 without `cfg(near)`, or default to the host implementation on wasm32.

## 4. 1Click API: a quote to a NEAR recipient that does not exist returns "400 Internal server error"

**What happens:** `POST /v0/quote` with `recipient` set to a NEAR account that does not exist returns HTTP 400 with message "Internal server error". The same request to an existing account succeeds.

**Suggested fix:** a specific message ("recipient account does not exist on NEAR"), which saves integrators a debugging session.

## 5. 1Click API docs: app fees without a partner JWT

**What happens:** without a JWT, a quote with `appFees: [{fee: 30}]` comes back with two entries of 15 bps each: half to the integrator, half to 1Click's fee account. This is reasonable, but not documented next to `appFees`.

**Suggested fix:** one sentence in the `appFees` description.
