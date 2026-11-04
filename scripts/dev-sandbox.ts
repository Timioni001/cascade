/**
 * pnpm dev [--static]
 *
 * The whole Cascade stack on your machine, clickable, with no keys and no
 * money: a NEAR sandbox with the real contracts, the same platform code that
 * runs on Cloudflare and on the Node server (API, relayer, demo shop, settler
 * every second) on :8788 in testnet demo mode, and the web app.
 *
 *   pnpm dev            web app with hot reload on :3000 (next dev, API proxied to :8788)
 *   pnpm dev --static   the production build served by the platform on :8788, like the Worker
 *
 * Open /shop, press "Pay with any crypto", pick a coin, then "Simulate the payment".
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { formatUsd } from "@cascade/core";
import { MemoryStore } from "@cascade/db";
import { createPlatform, parseConfig } from "@cascade/platform";
import { staticSite } from "../services/server/src/static.js";
import { createWorld } from "./sandbox/world.js";
import { onboardMerchant } from "./sandbox/checkout-flow.js";
import { seedMerchant } from "./sandbox/seed.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = process.argv.includes("--static");
const API_PORT = 8788;
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = STATIC ? `http://localhost:${API_PORT}` : "http://localhost:3000";

if (STATIC) {
  console.log("Building the web app...");
  const b = spawnSync("pnpm", ["--filter", "@cascade/web", "build"], { cwd: repo, stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_SANDBOX: "1" } });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

console.log("Starting NEAR sandbox and deploying Cascade...");
const w = await createWorld({ publicUrl: WEB });
const store = new MemoryStore();
const cfg = parseConfig(w.platformEnv(WEB), {}, "the sandbox");
const site = STATIC ? staticSite(resolve(repo, "apps/web/out")) : null;

function start(shop: { secretKey: string; webhookSecret: string } | null) {
  const p = createPlatform({ cfg: { ...cfg, shop }, store });
  if (site) p.app.get("*", site);
  return p;
}

// The platform starts without the demo shop, the shop onboards through its
// API like any merchant, then the platform restarts with the shop's keys.
let platform = start(null);
// Compressed like production (Cloudflare compresses; services/server does it with this middleware).
const root = new Hono();
root.use(compress());
root.all("*", (c) => platform.app.fetch(c.req.raw));
const server = serve({ fetch: root.fetch, port: API_PORT, hostname: "127.0.0.1" });
const shop = await w.signUp("oakline");
await w.engine.registerPerson(shop.gasless);
const keys = await onboardMerchant(w, shop, "Oakline Ceramics", `${WEB}/api/shop/webhook`, API);
platform = start(keys);
console.log(`Merchant ${shop.id} onboarded. Platform on ${API}`);
await seedMerchant(w, shop, store, (s) => console.log(`Seeded ${s}`));

let stopping = false;
(async () => {
  while (!stopping) {
    for (const e of await platform.settler.tick()) {
      if (e.type === "recorded") console.log(`[settler] receipt recorded on-chain (tx ${e.tx.slice(0, 10)}…). Shop balance: $${formatUsd(await w.usdcBalance(shop.id))}`);
      else if (e.type === "error") console.log(`[settler] ${e.where}: ${e.message}`);
      else if (e.type === "status") console.log(`[settler] ${e.depositAddress.slice(0, 10)}… ${e.from} -> ${e.to}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
})();

const web = STATIC
  ? null
  : spawn("pnpm", ["--filter", "@cascade/web", "dev"], {
      cwd: repo,
      stdio: "inherit",
      env: { ...process.env, CASCADE_DEV_API: API, NEXT_PUBLIC_SANDBOX: "1" },
    });
console.log(`\n  Demo shop:    ${WEB}/shop`);
console.log(`  Dashboard:    ${WEB}/dashboard   (secret key: ${keys.secretKey})`);
console.log(`  Agent (x402): in another terminal, pnpm agent\n`);

const stop = async () => {
  if (stopping) return;
  stopping = true;
  web?.kill("SIGTERM");
  server.close();
  await w.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
web?.on("exit", stop);
