#!/usr/bin/env bash
# pnpm cf:deploy: build the web app for this network and deploy the Worker.
# Run pnpm cf:configure first. Reads NEAR_NETWORK and CASCADE_ONECLICK from the
# Worker's vars, so the demo banner and "simulate" button appear only in testnet demo mode.
set -euo pipefail
cd "$(dirname "$0")/../.."
cfg=services/worker/wrangler.jsonc
network=$(grep -o '"NEAR_NETWORK": "[a-z]*"' "$cfg" | cut -d'"' -f4)
mode=$(grep -o '"CASCADE_ONECLICK": "[a-z]*"' "$cfg" | cut -d'"' -f4)
if grep -q '"database_id": "00000000-0000-0000-0000-000000000000"' "$cfg"; then
  echo "Set the D1 database id first: pnpm cf:configure --url ... --database-id <id>" >&2; exit 1
fi
sandbox=""; [ "$mode" = "mock" ] && sandbox=1
echo "Building the web app for $network (demo mode: ${sandbox:-no})..."
NEXT_PUBLIC_NEAR_NETWORK="$network" NEXT_PUBLIC_SANDBOX="$sandbox" pnpm --filter @cascade/web build
cd services/worker
pnpm exec wrangler d1 migrations apply cascade --remote
pnpm exec wrangler deploy
