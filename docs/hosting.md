# Hosting

Cascade is one deployment: the web app (checkout `/c/<id>`, receipts `/r/<id>`, dashboard, demo shop), the checkout API `/v1`, the relayer `/relayer`, the demo shop's backend `/api/shop` and the settler. The same platform code (`services/platform`) runs on two hosts:

| Host | What runs it | Database | Settler | Cost |
| --- | --- | --- | --- | --- |
| **Cloudflare** (recommended) | One Worker (`services/worker`) plus its static assets | D1 | Cron trigger every minute, plus a tick right after checkout pages and agents poll | Free plan |
| Any container host | One Node process (`services/server`, Dockerfile) | SQLite on a disk | Loop every 5 s | A small VM |

Do the [runbook](mainnet-runbook.md) first: the contract ids come from `deployments/<network>.json`.

## Cloudflare

Nothing needs to stay up on your machine: Cloudflare serves the pages, answers the API and runs the settler on its cron.

### Once

```bash
cd services/worker
pnpm exec wrangler login
pnpm exec wrangler d1 create cascade          # prints the database id
cd ../..
```

Pick the URL: `https://cascade.<your-subdomain>.workers.dev` (your workers.dev subdomain is shown in the Cloudflare dashboard under Workers).

### Configure, deploy

```bash
pnpm cf:configure --url https://cascade.<you>.workers.dev --database-id <id>
cd services/worker && pnpm exec wrangler secret bulk .secrets.json && rm .secrets.json && cd ../..
pnpm cf:deploy
```

- `cf:configure` checks `.env` and the deployment record with the Worker's own config parser, writes the public settings (contract ids, URL, mode, fee) into `wrangler.jsonc`, and writes the secrets (relayer and settler keys; in demo mode the mock USDC minter key; `ONECLICK_JWT` if set; the demo shop's keys) to a git-ignored `.secrets.json` for `wrangler secret bulk`.
- `cf:deploy` builds the web app for the network (demo banner and "simulate" button only in testnet demo mode), applies the D1 migration, and deploys.

Check: `curl https://cascade.<you>.workers.dev/health` returns `{"ok":true,"network":"testnet",...}`.

### Demo shop

```bash
pnpm demo-merchant --api https://cascade.<you>.workers.dev --web https://cascade.<you>.workers.dev
pnpm cf:configure --url https://cascade.<you>.workers.dev      # now includes the shop's keys
cd services/worker && pnpm exec wrangler secret bulk .secrets.json && rm .secrets.json
```

Secrets take effect without a redeploy. Open `/shop`, pay, then `/dashboard` with the secret key `demo-merchant` saved in `.env` (`DEMO_SHOP_SECRET_KEY`).

### Settings

Set by `cf:configure`; listed here for reference.

| Variable | Kind | Notes |
| --- | --- | --- |
| `NEAR_NETWORK` | var | `mainnet` or `testnet` |
| `CASCADE_PUBLIC_URL` | var | This deployment's URL. Checkout links, the relayer's allowed origin, and the origin whose calls stay in-process |
| Contract ids (`CASCADE_APP_ID`, ...) | vars | From `deployments/<network>.json` |
| `CASCADE_ONECLICK` | var | `live`, or `mock` for the testnet demo (simulated swaps that mint testnet mock USDC; refused on mainnet) |
| `CASCADE_FEE_BPS`, `CASCADE_FEE_RECIPIENT` | vars | Cascade fee (0-200 bps; the published price is 50 = 0.5%), paid by the customer |
| `CASCADE_ADMIN_TOKEN` | secret | Turns on the unlinked operator view at `/admin` (stats, applications, merchants). At least 24 characters: `openssl rand -hex 24` |
| `NEAR_RPC_URL` | var | Optional; default FastNEAR |
| `RELAYER_PRIVATE_KEY`, `SETTLER_PRIVATE_KEY` | secrets | Written to `.env` by `pnpm deploy:cascade` |
| `CASCADE_ROOT_PRIVATE_KEY` | secret | Demo mode only: the mock USDC minter (a testnet key) |
| `ONECLICK_JWT` | secret | Strongly recommended on mainnet: without it 1Click adds a fee and refuses private payments |
| `CASCADE_SHOP_SECRET_KEY`, `CASCADE_SHOP_WEBHOOK_SECRET` | secrets | The demo shop's merchant keys |

A missing or invalid setting makes the API answer 503 with the reason; the pages still load.

### How it fits the free plan

| Limit (free plan) | Cascade |
| --- | --- |
| 100,000 requests a day | Static pages, scripts and fonts are served without running the Worker (`run_worker_first` lists only API, checkout and receipt paths) |
| 3 MiB Worker (compressed) | About 145 KiB |
| 5 cron triggers per account | Uses one |
| 50 outgoing requests per invocation | A settler tick makes a few RPC calls per open payment; ticks run often, so each has little to do |
| 10 ms CPU per invocation | Most time is spent waiting on NEAR RPC and D1, which does not count. A tick that signs several transactions is the heaviest step. If ticks are cut short, they resume on the next one (every step is idempotent); Workers Paid ($5/month) raises the limit to 30 s |
| D1 | Rate limits, nonces, simulated swaps and the shop's orders live in D1 too, so every isolate sees the same state |

What changes from the Node server: rate limits and the onboarding replay guard are in D1 (atomic, shared), not in memory; a lease in D1 keeps settler ticks from overlapping; calls to the deployment's own URL (webhooks to the demo shop, the shop's API calls) are handled in-process because a Worker cannot fetch its own URL.

### Try it locally first (free, no account)

```bash
pnpm worker:local                                  # sandbox chain + the Worker in workerd + local D1, on :8787
CASCADE_WEB=http://localhost:8787 pnpm test:e2e    # in another terminal
SHOP_URL=http://localhost:8787 pnpm agent          # x402 agent against the Worker
```

## Node server (alternative)

Same settings as the table above, as environment variables (or `.env`), plus:

| Variable | Notes |
| --- | --- |
| `CASCADE_DB` | Default `.data/cascade.sqlite` (`/data/cascade.sqlite` in Docker) |
| `PORT` | Default 8788 |
| `TRUST_PROXY` | `1` behind a reverse proxy, so rate limits see the client IP |
| `CASCADE_WEB_DIR` | The web build to serve; default `apps/web/out` (build it with `NEXT_PUBLIC_NEAR_NETWORK=testnet NEXT_PUBLIC_SANDBOX=1 pnpm --filter @cascade/web build` for the demo) |

```bash
pnpm backend                                         # Node 22.13+
# or
docker compose up -d --build                         # builds the web app too; .env and a volume for /data
```

One instance only (the settler loop assumes it is alone). Put HTTPS in front and set `TRUST_PROXY=1`.

## After going live

- Keep the relayer funded: it pays every user's gas and each new name (0.01 NEAR + USDC registration). Watch its balance on nearblocks.
- Do one checkout and put the links (checkout, receipt, NEAR transaction) in the README's Proof section.
