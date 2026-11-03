# Hosting

Two pieces, deployed separately:

| Piece | What it is | Where | Needs |
| --- | --- | --- | --- |
| Backend (`services/server`) | Checkout API `/v1`, relayer `/relayer`, settler loop, SQLite | Any small VM or container host with a persistent disk (Fly.io, Railway, a $5 VPS) | Relayer and settler keys, a disk for `/data` |
| Web app (`apps/web`) | Hosted checkout `/c/[id]`, receipts `/r/[id]`, dashboard, demo shop | Vercel (or any Next.js host) | Only public URLs (and the demo shop's merchant key) |

Do the [mainnet runbook](mainnet-runbook.md) first: the backend reads its contract ids from `deployments/<network>.json`.

## Backend

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `NEAR_NETWORK` | yes | `mainnet` or `testnet` |
| `RELAYER_PRIVATE_KEY`, `SETTLER_PRIVATE_KEY` | yes | Written to `.env` by `pnpm deploy:cascade` |
| `CASCADE_PUBLIC_URL` | yes | Where the web app lives, e.g. `https://cascade.example`. Used in checkout links and as the allowed CORS origin for the relayer |
| `ONECLICK_JWT` | strongly recommended | Partner JWT from partners.near-intents.org. Without it: extra fee and no private payments |
| `CASCADE_FEE_BPS`, `CASCADE_FEE_RECIPIENT` | optional | Cascade's fee (0-200 bps), paid by the customer into this NEAR Intents account |
| `CASCADE_ALLOW_ORIGINS` | optional | Extra origins allowed to call the relayer, comma-separated |
| `CASCADE_ONECLICK` | optional | `live` (default) or `mock`: the testnet demo mode (simulated swaps that mint testnet mock USDC; refused on mainnet). Needs `CASCADE_ROOT_PRIVATE_KEY`, the mock token's minter. See the [runbook](mainnet-runbook.md) Part A |
| `NEAR_RPC_URL` | optional | Defaults to FastNEAR's free RPC |
| `CASCADE_DB` | optional | Default `.data/cascade.sqlite` (`/data/cascade.sqlite` in Docker) |
| `PORT` | optional | Default 8788 |
| `TRUST_PROXY` | optional | `1` behind a reverse proxy, so rate limits see the client IP |
| Contract ids | from `deployments/<network>.json` | Override with `CASCADE_APP_ID`, `CASCADE_FACTORY_ID`, `USDC_CONTRACT_ID`, `SPUTNIK_FACTORY_ID`, `RELAYER_ACCOUNT_ID`, `SETTLER_ACCOUNT_ID` |

The server refuses to start, with a message naming the missing setting, if anything required is absent.

### Run

```bash
pnpm backend                    # on a machine with Node 22.13+
# or
docker compose up -d --build    # uses .env and a named volume for /data
```

Check: `curl https://<backend>/health` returns `{"ok":true,"network":"mainnet","app":"app.<root>"}`.

One instance only: rate limits and the onboarding replay guard are in memory, and the settler assumes it is the only one writing. Put HTTPS in front (Caddy, the platform's proxy) and set `TRUST_PROXY=1`.

Keep the relayer funded: it pays every user's gas and each new name (0.01 NEAR + USDC registration). `GET /relayer/health` is cheap to monitor; watch the relayer account's balance on nearblocks.

## Web app (Vercel)

1. Import the repository, set **Root Directory** to `apps/web`. Vercel detects Next.js and pnpm.
2. Environment variables:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_CASCADE_API` | `https://<backend>` |
| `NEXT_PUBLIC_NEAR_NETWORK` | `mainnet` or `testnet` (explorer links point to that network) |
| `CASCADE_API_URL` | `https://<backend>` (server-side calls: dashboard proxy, demo shop) |
| `CASCADE_SECRET_KEY`, `CASCADE_WEBHOOK_SECRET` | Only for the demo shop: a merchant you onboarded |

3. Set `NEXT_PUBLIC_SANDBOX=1` only for the testnet demo (backend in `CASCADE_ONECLICK=mock`): it shows the demo banner and the "simulate payment" button. Never in production.
4. Set the backend's `CASCADE_PUBLIC_URL` to the Vercel URL, and the demo merchant's webhook URL to `https://<web>/api/shop/webhook`.

## After going live

- Onboard a merchant (NEP-413 signature from the receiving account), then open `https://<web>/dashboard` with its secret key.
- Do one real $1 checkout and put the links (checkout, receipt, NEAR transaction) in the README.
