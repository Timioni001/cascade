/**
 * pnpm dev
 *
 * The whole Cascade stack on your machine, clickable, with no keys and no
 * money: a NEAR sandbox with the real contracts, the checkout API on :8788,
 * the settler running every second, mock NEAR Intents, and the web app on
 * :3000 with a demo shop already onboarded as a merchant.
 *
 * Open http://localhost:3000/shop, press "Pay with any crypto", pick a coin,
 * then "Simulate the payment (sandbox)".
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUsd } from "@cascade/core";
import { createWorld } from "./sandbox/world.js";
import { onboardMerchant } from "./sandbox/checkout-flow.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = 8788;
const WEB = "http://localhost:3000";

console.log("Starting NEAR sandbox and deploying Cascade...");
const w = await createWorld({ apiPort: API_PORT, publicUrl: WEB });
const shop = await w.signUp("lagos-prints");
await w.engine.registerPerson(shop.gasless);
const keys = await onboardMerchant(w, shop, "Lagos Prints", `${WEB}/api/shop/webhook`);
console.log(`Merchant ${shop.id} onboarded. API on http://127.0.0.1:${API_PORT}`);

let stopping = false;
(async () => {
  while (!stopping) {
    for (const e of await w.settler.tick()) {
      if (e.type === "recorded") console.log(`[settler] receipt recorded on-chain (tx ${e.tx.slice(0, 10)}…). Shop balance: $${formatUsd(await w.usdcBalance(shop.id))}`);
      else if (e.type === "error") console.log(`[settler] ${e.where}: ${e.message}`);
      else if (e.type === "status") console.log(`[settler] ${e.depositAddress.slice(0, 10)}… ${e.from} -> ${e.to}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
})();

const web = spawn("pnpm", ["--filter", "@cascade/web", "dev"], {
  cwd: repo,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_CASCADE_API: `http://127.0.0.1:${API_PORT}`,
    NEXT_PUBLIC_SANDBOX: "1",
    CASCADE_API_URL: `http://127.0.0.1:${API_PORT}`,
    CASCADE_SECRET_KEY: keys.secretKey,
    CASCADE_WEBHOOK_SECRET: keys.webhookSecret,
  },
});
console.log(`\n  Demo shop:  ${WEB}/shop\n`);

const stop = async () => {
  if (stopping) return;
  stopping = true;
  web.kill("SIGTERM");
  await w.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
web.on("exit", stop);
