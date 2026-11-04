/**
 * pnpm backend
 *
 * Cascade in one Node process: the platform (API, relayer, demo shop), the
 * settler loop, and the web app's static build (apps/web/out) if present.
 * For Cloudflare, see services/worker. Configuration: docs/hosting.md.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { SqliteStore } from "@cascade/db";
import { createPlatform } from "@cascade/platform";
import { ConfigError, loadConfig } from "./config.js";
import { staticSite } from "./static.js";

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
const p = createPlatform({
  cfg, store,
  onSettlerEvent: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), settler: e })),
});

const site = resolve(process.env.CASCADE_WEB_DIR ?? "apps/web/out");
if (existsSync(site)) p.app.get("*", staticSite(site));

serve({ fetch: p.app.fetch, port: cfg.port, hostname: "0.0.0.0" });
console.log(
  `cascade server on :${cfg.port} (${cfg.network}, app ${cfg.app}, 1Click ${p.mock ? "SIMULATED (testnet demo)" : cfg.oneclickJwt ? "live, with partner JWT" : "live, without partner JWT"}` +
    `, web ${existsSync(site) ? site : "not built"})`,
);

const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop.abort());
await p.settler.run(cfg.settlerIntervalMs, stop.signal);
process.exit(0);
