# Contract binaries

Prebuilt so `pnpm demo` and `pnpm test:sandbox` run without a Rust toolchain.
Rebuild with `pnpm build:contracts` (needs Rust and the wasm32 target); it
rewrites `SHA256SUMS`.

| File | Source | Notes |
| --- | --- | --- |
| `cascade_app.wasm` | `contracts/app` | near-sdk 5.29.1, built with `--cfg near -C target-cpu=mvp` |
| `cascade_factory.wasm` | `contracts/factory` | same flags |
| `mock_usdc.wasm` | `contracts/mock-usdc` | **sandbox only**, never deploy |
| `sputnikdao2.wasm` | not ours | Sputnik DAO v2 code read from mainnet with RPC `view_code` on `devhub.sputnik-dao.near` (also used by `marketing.sputnik-dao.near` and `build.sputnik-dao.near`), code hash `2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK`, fetched 2026-11-03 |

Why near-sdk 5.29.1 and not 5.30: 5.30 (released 2026-10-27) imports host
functions such as `promise_batch_action_universal_state_init` that nearcore
2.14.0, the version mainnet runs, does not provide. Deploying a 5.30 build
fails with `Link Error: unknown or invalid import`.

Why `--cfg near`: near-sdk 5.29 only calls NEAR's host `panic_utf8` when built
with it (cargo-near sets it). Without it every `require!` message becomes a
bare `unreachable` trap.
