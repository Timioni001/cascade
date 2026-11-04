/**
 * pnpm worker:local
 *
 * Runs the real Cloudflare Worker (services/worker, in workerd via
 * `wrangler dev`, with a local D1) against a local NEAR sandbox with the real
 * contracts, in testnet demo mode. The same thing you deploy, minus Cloudflare's
 * network. Free; no Cloudflare account needed.
 *
 *   1. build the web app (static export)
 *   2. start the sandbox, deploy Cascade, write services/worker/.dev.vars
 *   3. apply the D1 migration locally, start wrangler dev on :8787
 *   4. onboard the demo shop through the Worker's API, restart with its keys
 *
 * Then: CASCADE_WEB=http://localhost:8787 pnpm test:e2e
 * The settler ticks after checkout polls (as in production); to run the
 * cron handler by hand, see the "Cron tick" line printed at the end.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld } from "../sandbox/world.js";
import { onboardMerchant } from "../sandbox/checkout-flow.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const worker = resolve(repo, "services/worker");
const PORT = 8787;
const WEB = `http://localhost:${PORT}`;
const wrangler = (args: string[]) => spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: worker, stdio: "inherit" });

console.log("Building the web app...");
if (spawnSync("pnpm", ["--filter", "@cascade/web", "build"], { cwd: repo, stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_SANDBOX: "1" } }).status !== 0) process.exit(1);

console.log("Starting NEAR sandbox and deploying Cascade...");
const w = await createWorld({ publicUrl: WEB });
const vars = w.platformEnv(WEB);
const writeVars = (extra: Record<string, string> = {}) =>
  writeFileSync(resolve(worker, ".dev.vars"), Object.entries({ ...vars, ...extra }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });

rmSync(resolve(worker, ".wrangler/state"), { recursive: true, force: true });
writeVars();
if (wrangler(["d1", "migrations", "apply", "cascade", "--local"]).status !== 0) process.exit(1);

let dev: ChildProcess | null = null;
async function startWorker() {
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(PORT), "--show-interactive-dev-session=false"], { cwd: worker, stdio: "inherit" });
  for (let i = 0; i < 90; i++) {
    const ok = await fetch(`${WEB}/health`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev did not come up");
}
async function stopWorker() {
  if (!dev) return;
  const d = dev;
  await new Promise<void>((r) => {
    d.once("exit", () => r());
    d.kill("SIGINT");
  });
  dev = null;
}

await startWorker();
const shop = await w.signUp("oakline");
await w.engine.registerPerson(shop.gasless);
const keys = await onboardMerchant(w, shop, "Oakline Ceramics", `${WEB}/api/shop/webhook`, WEB);
await stopWorker();
writeVars({ CASCADE_SHOP_SECRET_KEY: keys.secretKey, CASCADE_SHOP_WEBHOOK_SECRET: keys.webhookSecret });
await startWorker();

console.log(`\n  Worker:       ${WEB}  (health: ${JSON.stringify(await (await fetch(`${WEB}/health`)).json())})`);
console.log(`  Demo shop:    ${WEB}/shop`);
console.log(`  Dashboard:    ${WEB}/dashboard   (secret key: ${keys.secretKey})`);
console.log(`  Cron tick:    curl -X POST "${WEB}/cdn-cgi/local/explorer/api/local/scheduled?worker=cascade" -H 'content-type: application/json' -d '{"cron":"* * * * *"}'\n`);

const stop = async () => {
  await stopWorker();
  await w.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
