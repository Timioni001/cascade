# NEAR HACKATHON disclosures

## Code written during the hackathon

Everything in this repository except the one-line README of the initial commit was written during the hackathon window (2026-10-19 to 2026-11-14).

- Baseline: tag `pre-hackathon` (the initial commit, README only)
- Submission: tag `hackathon-submission` (to be created at submission)
- Diff: https://github.com/timioni001/cascade/compare/pre-hackathon...hackathon-submission

## Tracks

- `realworld` (08, Real-World Money): main track
- `social` (12, Social Money): Sputnik DAO team payroll
- `privacy` (03): only if private payments are shown working on mainnet

## AI-written code

Most of the code was written by Claude Code (Anthropic) working with the team lead, who directed the design and reviewed it. AI-written: all contracts, packages, services, scripts, tests and docs in this repository.

## Libraries and third-party code

| Name | Version | Use |
| --- | --- | --- |
| near-sdk, near-contract-standards (Rust) | 5.29.1 | Contracts; mock USDC |
| hex (Rust) | 0.4 | Hex encoding in the contract |
| near-api-js | 7.4.0 | RPC, signing, NEP-366 meta-transactions |
| borsh | 2.0.0 | Decoding signed delegate actions |
| @noble/hashes | 2.2.0 | SHA-256 for line and invoice hashes |
| near-sandbox | 0.3.4 | Local NEAR node for demo and tests |
| hono, @hono/node-server | 4.12.34, 2.1.5 | Relayer and checkout API servers |
| next, react, react-dom | 15.5.28, 19.1.10 | Hosted checkout page and demo shop |
| qrcode | 1.5.4 | QR codes for wallet payment links |
| lucide-react | 1.59.0 | Icons |
| Geist, Geist Mono (via next/font) | | Typeface |
| vitest, tsx, typescript | 4.1.12, 4.23.15, 5.9.3 | Tests and tooling |
| Sputnik DAO v2 (wasm) | mainnet code hash 2Zof1Tyy... | Real DAO contract in the sandbox; not modified. See contracts/res/README.md |

No templates or boilerplate were used. The 1Click types were transcribed from its OpenAPI spec; the x402 messages follow the x402 v2 specification (github.com/coinbase/x402).

## Other projects

None. This is the team's only submission.
