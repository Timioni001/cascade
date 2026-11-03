#!/usr/bin/env bash
# Build the Cascade contracts to wasm and copy them into contracts/res/.
# The prebuilt wasm in contracts/res/ is committed so `pnpm demo` works
# without a Rust toolchain; run this after changing any contract.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
# target-cpu=mvp keeps the wasm to features NEAR's VM accepts.
RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s" cargo build --target wasm32-unknown-unknown --release
for c in cascade_app cascade_factory mock_usdc; do
  cp "target/wasm32-unknown-unknown/release/$c.wasm" "res/$c.wasm"
done
(cd res && sha256sum *.wasm > SHA256SUMS)
cat res/SHA256SUMS
