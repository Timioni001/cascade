# Runbook: testnet rehearsal, then mainnet (from WSL)

Everything here runs on your machine with your keys. Nothing is signed until you type `yes` at a prompt that shows the exact transaction. Add `--dry-run` to any command to see the full plan without signing.

## 0. Once

```bash
cd ~/cascade
cp .env.example .env      # stays on your machine; it is in .gitignore
chmod 600 .env
```

## 1. Testnet rehearsal (free)

1. Create a testnet account in a wallet (e.g. `cascade-yourname.testnet`, fund it from the faucet at near-faucet.io, ~20 NEAR). Export its private key from the wallet.
2. In `.env`: `NEAR_NETWORK=testnet`, `CASCADE_ROOT_ID=cascade-yourname.testnet`, `CASCADE_ROOT_PRIVATE_KEY=ed25519:...`
3. `pnpm deploy:cascade --dry-run`: read the plan.
4. `pnpm deploy:cascade`: approve each step. It creates `relayer.` and `settler.` sub-accounts (keys appended to `.env`), deploys the mock USDC, the locked app and the factory, then verifies them. Result: `deployments/testnet.json`.
5. Run it again: it should send nothing.
6. `pnpm spike name` then `pnpm spike relay`: a name created by the factory, then a fee-free `register_owner` through the relayer. The output shows the user's NEAR change (should be 0).

## 2. Mainnet

Cost: about 15 NEAR for accounts and contract storage (the app is funded from its code size, ~5.3 NEAR; storage is refundable if an account is deleted), plus ~$1 per spike. Fund the root with ~20 NEAR.

1. Create a **dedicated** mainnet account for Cascade (e.g. `cascade-yourname.near`) with ~20 NEAR. Do not use your personal account: the factory contract is deployed onto it.
2. In `.env`: `NEAR_NETWORK=mainnet`, the new root id and key, `USDC_CONTRACT_ID=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, `SPUTNIK_FACTORY_ID=sputnik-dao.near`. Remove the testnet relayer/settler lines (or keep a separate `.env.testnet`).
3. `pnpm deploy:cascade --dry-run`, then `pnpm deploy:cascade`.
4. Commit `deployments/mainnet.json` (public information only) and set `CASCADE_APP_ID` / `CASCADE_FACTORY_ID` in `.env`.

## 3. Spikes (mainnet, ~$1 each)

| Spike | Command | You do |
| --- | --- | --- |
| Incoming | `pnpm spike incoming --refund-to <your Base address>` | Send the exact USDC (or `--asset nep141:base.omft.near` for ETH) from your wallet to the printed address; paste the tx hash |
| Expired quote | `pnpm spike expired --refund-to <your Base address>` | Wait until the printed deadline passes, then send. Watch what 1Click does |
| Outgoing | `pnpm spike outgoing --chain base --recipient <your Base address>` | Needs `SPIKE_ACCOUNT_ID/KEY`: a NEAR account with a few USDC. Shows whether the deposit address needs a USDC storage deposit |
| Private | `pnpm spike private --chain base --recipient <address>` | Needs `ONECLICK_JWT`. Afterwards look at both explorers and note what is visible |
| Name, relay | `pnpm spike name`, `pnpm spike relay` | As on testnet |
| Revenue split | `pnpm spike split --refund-to <your Base address>` | After name and relay. Pays $1 into a 90/10 split through 1Click's experimental `customRecipientMsg`. If no split batch appears, splits must stay off on mainnet |

Each run appends to `deployments/mainnet-spikes.json` (no keys). Copy the transaction links into `docs/spikes.md` and the README.

If a watch times out (Bitcoin is slow), check later: `pnpm spike status --deposit <address>`.

## What the scripts refuse to do

- Sign anything without a typed `yes`.
- Deploy the mock USDC to mainnet.
- Change an app contract that already exists (it is locked: no access keys).
- Deploy the factory onto an account that already has other code.
- Overwrite a key already in `.env`.
- Spend more than $5 in a spike without `--allow-more`.
- Quote to a NEAR account that does not exist.
