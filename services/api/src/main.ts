import { serve } from "@hono/node-server";
import { SqliteStore } from "@cascade/db";
import { Checkout } from "@cascade/engine";
import { Chain } from "@cascade/near";
import { HttpOneClick } from "@cascade/oneclick";
import { apiApp } from "./app.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (see .env.example)`);
  return v;
};

const checkout = new Checkout({
  store: await SqliteStore.open(process.env.CASCADE_DB ?? ".data/cascade.sqlite"),
  oneclick: new HttpOneClick({ ...(process.env.ONECLICK_JWT ? { jwt: process.env.ONECLICK_JWT } : {}) }),
  chain: new Chain(need("NEAR_RPC_URL"), (process.env.NEAR_NETWORK ?? "mainnet") as "mainnet"),
  app: need("CASCADE_APP_ID"),
  publicUrl: need("CASCADE_PUBLIC_URL"),
  keyMode: process.env.NEAR_NETWORK === "mainnet" ? "live" : "test",
});
const port = Number(process.env.API_PORT ?? 8788);
serve({ fetch: apiApp({ checkout, trustProxy: process.env.TRUST_PROXY === "1" }).fetch, port });
console.log(`checkout api listening on :${port}`);
