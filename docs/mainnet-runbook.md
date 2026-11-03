# Runbook: testnet live demo (free), then a mainnet proof (under $5)

Everything here runs on your machine (WSL) with your keys. Nothing is signed until you type `yes` at a prompt that shows the exact transaction. Add `--dry-run` to any command to see the plan without signing.

**Why this split.** Deploying the contracts to mainnet locks about 15-20 NEAR for storage (roughly $60-75), which is over the hackathon budget. The hackathon allows testnet projects (rule Q-010); only NEAR Intents (1Click) is mainnet-only. So:

| Part | Network | Cost | What it proves |
| --- | --- | --- | --- |
| A. Live demo | Testnet | $0 (faucet NEAR) | Every contract, the checkout, receipts, splits, refunds, DAO payroll, webhooks, the dashboard, live on a public URL. Only the cross-chain swap is simulated (there is no Intents testnet) |
| B. Mainnet proof | Mainnet | about $2.50-3.50 | Real cross-chain payments through 1Click: $1 in from Base to your NEAR account, and the same $1 back out |

Keep two env files and copy the one you need to `.env` (`cp .env.testnet .env`). `.env*` is git-ignored.

## 0. Once

```bash
cd ~/cascade
cp .env.example .env.testnet && chmod 600 .env.testnet
```

## Part A. Testnet live demo ($0)

### A1. Deploy

1. Create a testnet account in a wallet (e.g. `cascade-yourname.testnet`, ~20 NEAR from the faucet at near-faucet.io). Export its private key.
2. In `.env.testnet`: `NEAR_NETWORK=testnet`, `CASCADE_ROOT_ID=cascade-yourname.testnet`, `CASCADE_ROOT_PRIVATE_KEY=ed25519:...`. Then `cp .env.testnet .env`.
3. `pnpm deploy:cascade --dry-run`, read it, then `pnpm deploy:cascade`. It creates `relayer.` and `settler.` accounts (keys appended to `.env`), the mock USDC (minter: your root), the locked app and the factory, and verifies them. Result: `deployments/testnet.json` (commit it).
4. Optional checks: `pnpm spike name`, then `pnpm spike relay` (a name, then a fee-free registration; the user's NEAR change is 0).

### A2. Host the backend (testnet demo mode)

Same server as production, with the swap simulated. Add to `.env`:

```
CASCADE_ONECLICK=mock        # testnet only; the server refuses it on mainnet
CASCADE_PUBLIC_URL=https://<your web app URL>
CASCADE_FEE_BPS=30           # optional: shows the fee line in checkout
CASCADE_FEE_RECIPIENT=<root>.testnet
```

`CASCADE_ROOT_PRIVATE_KEY` must be set: in demo mode the root mints the mock USDC that a "simulated payment" delivers. That key controls only testnet accounts.

Run it where it can stay up through judging (Nov 16-18): `docker compose up -d --build` on any small host, or `pnpm backend` on your machine behind a free tunnel (`cloudflared tunnel --url http://localhost:8788`). Details: [hosting.md](hosting.md).

### A3. Host the web app (Vercel, free)

Root directory `apps/web`, env:

```
NEXT_PUBLIC_CASCADE_API=https://<backend URL>
CASCADE_API_URL=https://<backend URL>
NEXT_PUBLIC_NEAR_NETWORK=testnet
NEXT_PUBLIC_SANDBOX=1        # shows the banner and the "Simulate the payment" button
```

### A4. Onboard the demo shop

```bash
pnpm demo-merchant --api https://<backend> --web https://<web>
```

It creates `lagos-prints.<root>`, registers it fee-free, onboards it with a signed message, and saves `DEMO_SHOP_SECRET_KEY` / `DEMO_SHOP_WEBHOOK_SECRET` to `.env`. Set them on Vercel as `CASCADE_SECRET_KEY` / `CASCADE_WEBHOOK_SECRET` and redeploy. Then open `https://<web>/shop`, pay, and check the receipt's testnet transaction on testnet.nearblocks.io.

## Part B. Mainnet proof (under $5)

No Cascade contract is deployed to mainnet. The money moves between your own accounts through 1Click; the scripts cap each run at $5 and stop on the first error.

You need: a mainnet NEAR account of yours with ~0.1 NEAR for gas (about $0.40), and ~$1.10 of USDC on Base plus a few cents of ETH on Base in a wallet such as MetaMask. Optional: `ONECLICK_JWT` (without it 1Click adds a small fee).

`.env.mainnet`:

```
NEAR_NETWORK=mainnet
CASCADE_ROOT_ID=<your-account>.near       # only used as the default recipient; nothing is deployed
SPIKE_ACCOUNT_ID=<your-account>.near
SPIKE_PRIVATE_KEY=ed25519:...             # that account's key, for step B2 only
```

`cp .env.mainnet .env`, then:

| Step | Command | Cost | You do |
| --- | --- | --- | --- |
| B1. In: Base -> NEAR | `pnpm spike incoming --refund-to <your Base address>` | ~$1.02 + Base gas | Send the exact USDC amount it prints from your wallet; paste the tx hash. It watches until 1Click says SUCCESS and the USDC is in your NEAR account |
| B2. Out: NEAR -> Base | `pnpm spike outgoing --chain base --recipient <your Base address>` | ~$0.02 + 0.01 NEAR | Signs two NEAR transactions (storage registration if needed, then the transfer). Your $1 comes back on Base |
| B3. Optional: expired quote | `pnpm spike expired --refund-to <your Base address>` | ~$1 (should be refunded) | Wait for the printed deadline, then send. Shows what 1Click does with late deposits |

Total for B1 + B2: about $1.10 spent, $1 of it returned to you. Results go to `deployments/mainnet-spikes.json` (commit it); put the transaction links in the README's Proof section.

Not run on mainnet (they need the app contract there): the revenue-split delivery (`spike split`) and the fee check. Both are tested on the local node; the README says so.

## What the scripts refuse to do

- Sign anything without a typed `yes`.
- Deploy the mock USDC to mainnet, or run the server's simulated 1Click on mainnet.
- Change an app contract that already exists (it is locked: no access keys).
- Deploy the factory onto an account that already has other code.
- Overwrite a key already in `.env`.
- Spend more than $5 in a spike without `--allow-more`.
- Quote to a NEAR account that does not exist.
