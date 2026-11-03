import { serve } from "@hono/node-server";
import { Chain } from "@cascade/near";
import { Relayer } from "./relayer.js";
import { relayerApp } from "./server.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (see .env.example)`);
  return v;
};

const chain = new Chain(need("NEAR_RPC_URL"), (process.env.NEAR_NETWORK ?? "mainnet") as "mainnet");
const relayer = new Relayer({
  chain,
  payer: chain.account(need("RELAYER_ACCOUNT_ID"), need("RELAYER_PRIVATE_KEY") as `ed25519:${string}`),
  app: need("CASCADE_APP_ID"),
  usdc: need("USDC_CONTRACT_ID"),
  factory: need("CASCADE_FACTORY_ID"),
  daoFactory: process.env.SPUTNIK_FACTORY_ID ?? "sputnik-dao.near",
});
const port = Number(process.env.RELAYER_PORT ?? 8787);
serve({ fetch: relayerApp(relayer, { trustProxy: process.env.TRUST_PROXY === "1" }).fetch, port });
console.log(`relayer listening on :${port}`);
