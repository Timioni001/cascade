/**
 * pnpm cf:configure --url https://cascade.<you>.workers.dev [--database-id <D1 id>]
 *
 * Prepares the Cloudflare Worker for your deployment, from .env and
 * deployments/<network>.json, after checking them with the same parser the
 * Worker uses (so a missing setting fails here, not in production):
 *   - writes the public settings into services/worker/wrangler.jsonc "vars"
 *     (contract ids, URLs, mode, fee: nothing secret);
 *   - writes the secrets to services/worker/.secrets.json (git-ignored, 0600)
 *     for `wrangler secret bulk`, and tells you to delete it afterwards.
 * Signs nothing and calls nothing. Steps around it: docs/hosting.md.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@cascade/platform";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

try {
  process.loadEnvFile(resolve(repo, ".env"));
} catch {
  /* environment only */
}
const env = { ...process.env } as Record<string, string | undefined>;
const url = arg("url")?.replace(/\/$/, "");
if (!url || !/^https:\/\//.test(url)) {
  console.error("usage: pnpm cf:configure --url https://cascade.<you>.workers.dev [--database-id <D1 id>]");
  process.exit(1);
}
env.CASCADE_PUBLIC_URL = url;
// The demo shop's keys come from `pnpm demo-merchant` (saved as DEMO_SHOP_*).
env.CASCADE_SHOP_SECRET_KEY ??= env.DEMO_SHOP_SECRET_KEY;
env.CASCADE_SHOP_WEBHOOK_SECRET ??= env.DEMO_SHOP_WEBHOOK_SECRET;

const network = env.NEAR_NETWORK ?? "testnet";
const depFile = resolve(repo, env.CASCADE_DEPLOYMENT ?? `deployments/${network}.json`);
const dep = existsSync(depFile) ? (JSON.parse(readFileSync(depFile, "utf8")) as Record<string, unknown>) : {};
const cfg = parseConfig(env, dep, depFile); // throws with a clear message if anything is missing

const vars: Record<string, string> = {
  NEAR_NETWORK: cfg.network,
  CASCADE_PUBLIC_URL: cfg.publicUrl,
  CASCADE_APP_ID: cfg.app,
  CASCADE_FACTORY_ID: cfg.factory,
  USDC_CONTRACT_ID: cfg.usdc,
  SPUTNIK_FACTORY_ID: cfg.daoFactory,
  RELAYER_ACCOUNT_ID: cfg.relayer.id,
  SETTLER_ACCOUNT_ID: cfg.settler.id,
  CASCADE_ONECLICK: cfg.oneclick.mode,
  ...(cfg.oneclick.mode === "mock" ? { CASCADE_ROOT_ID: cfg.oneclick.minter.id } : {}),
  ...(cfg.fee ? { CASCADE_FEE_BPS: String(cfg.fee.bps), CASCADE_FEE_RECIPIENT: cfg.fee.recipient } : {}),
  ...(env.NEAR_RPC_URL ? { NEAR_RPC_URL: env.NEAR_RPC_URL } : {}),
  ...(env.CASCADE_ALLOW_ORIGINS ? { CASCADE_ALLOW_ORIGINS: env.CASCADE_ALLOW_ORIGINS } : {}),
};
const secrets: Record<string, string> = {
  RELAYER_PRIVATE_KEY: cfg.relayer.key,
  SETTLER_PRIVATE_KEY: cfg.settler.key,
  ...(cfg.oneclick.mode === "mock" ? { CASCADE_ROOT_PRIVATE_KEY: cfg.oneclick.minter.key } : {}),
  ...(cfg.oneclickJwt ? { ONECLICK_JWT: cfg.oneclickJwt } : {}),
  ...(cfg.shop ? { CASCADE_SHOP_SECRET_KEY: cfg.shop.secretKey, CASCADE_SHOP_WEBHOOK_SECRET: cfg.shop.webhookSecret } : {}),
};

const wranglerFile = resolve(repo, "services/worker/wrangler.jsonc");
let w = readFileSync(wranglerFile, "utf8");
const varsBlock = `"vars": ${JSON.stringify(vars, null, 2).replace(/\n/g, "\n  ")}`;
w = w.replace(/"vars": \{[\s\S]*?\n  \}/, varsBlock);
const dbId = arg("database-id");
if (dbId) {
  if (!/^[0-9a-f-]{36}$/.test(dbId)) throw new Error("--database-id must be the D1 database's UUID (wrangler d1 create cascade prints it)");
  w = w.replace(/"database_id": "[^"]*"/, `"database_id": "${dbId}"`);
}
writeFileSync(wranglerFile, w);

const secretsFile = resolve(repo, "services/worker/.secrets.json");
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });

console.log(`✓ ${network}, app ${cfg.app}, 1Click ${cfg.oneclick.mode === "mock" ? "SIMULATED (testnet demo)" : "live"}, demo shop ${cfg.shop ? "on" : "off (run pnpm demo-merchant, then this again)"}`);
console.log(`✓ wrangler.jsonc vars updated${dbId ? " (and the D1 database id)" : ""}: ${Object.keys(vars).join(", ")}`);
console.log(`✓ secrets written to services/worker/.secrets.json: ${Object.keys(secrets).join(", ")}`);
console.log("\nNext, from services/worker:");
console.log("  pnpm exec wrangler secret bulk .secrets.json && rm .secrets.json");
console.log("  (then deploy: pnpm cf:deploy from the repo root)");
