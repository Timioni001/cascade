/**
 * pnpm backend
 *
 * Cascade's whole backend in one process:
 *   /v1/...         checkout API (merchants, sessions, refunds, x402, receipts)
 *   /relayer/...    fee-free actions (NEP-366) and name sign-up
 *   settler loop    records 1Click deliveries, pays batches, sends webhooks
 * Configuration: see config.ts and docs/hosting.md.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SqliteStore } from "@cascade/db";
import { AgentPayments, Checkout, Refunds, checkoutHooks } from "@cascade/engine";
import { Chain } from "@cascade/near";
import { HttpOneClick } from "@cascade/oneclick";
import { apiApp } from "@cascade/api";
import { Relayer, relayerApp } from "@cascade/relayer";
import { Settler, nearSettlerChain } from "@cascade/settler";
import { ConfigError, loadConfig } from "./config.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env: environment only */
}

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`config: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

mkdirSync(dirname(cfg.dbPath), { recursive: true });
const store = await SqliteStore.open(cfg.dbPath);
const chain = new Chain(cfg.rpc, cfg.network);
const oneclick = new HttpOneClick(cfg.oneclickJwt ? { jwt: cfg.oneclickJwt } : {});
const checkout = new Checkout({
  store, oneclick, chain, app: cfg.app, publicUrl: cfg.publicUrl, keyMode: cfg.network === "mainnet" ? "live" : "test",
  ...(cfg.fee ? { fee: cfg.fee } : {}),
});
const refunds = new Refunds(checkout);
const relayer = new Relayer({
  chain, payer: chain.account(cfg.relayer.id, cfg.relayer.key), app: cfg.app, usdc: cfg.usdc, factory: cfg.factory, daoFactory: cfg.daoFactory,
});
const settler = new Settler({
  oneclick, store, chain: nearSettlerChain(chain, chain.account(cfg.settler.id, cfg.settler.key), cfg.app),
  hooks: checkoutHooks(checkout, fetch, refunds),
  onEvent: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), settler: e })),
});

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, network: cfg.network, app: cfg.app }));
app.route("/relayer", relayerApp(relayer, { trustProxy: cfg.trustProxy, allowOrigins: cfg.allowOrigins }));
app.route("/", apiApp({ checkout, refunds, agents: new AgentPayments(checkout), trustProxy: cfg.trustProxy }));

serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" });
console.log(`cascade server on :${cfg.port} (${cfg.network}, app ${cfg.app}, 1Click ${cfg.oneclickJwt ? "with" : "without"} partner JWT)`);

const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop.abort());
await settler.run(cfg.settlerIntervalMs, stop.signal);
process.exit(0);
