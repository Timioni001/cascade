import { Chain } from "@cascade/near";
import { HttpOneClick } from "@cascade/oneclick";
import { SqliteStore } from "@cascade/db";
import { Settler } from "./settler.js";
import { nearSettlerChain } from "./chain.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (see .env.example)`);
  return v;
};

const chain = new Chain(need("NEAR_RPC_URL"), (process.env.NEAR_NETWORK ?? "mainnet") as "mainnet");
const settler = new Settler({
  oneclick: new HttpOneClick({ ...(process.env.ONECLICK_JWT ? { jwt: process.env.ONECLICK_JWT } : {}) }),
  store: await SqliteStore.open(process.env.CASCADE_DB ?? ".data/cascade.sqlite"),
  chain: nearSettlerChain(chain, chain.account(need("SETTLER_ACCOUNT_ID"), need("SETTLER_PRIVATE_KEY") as `ed25519:${string}`), need("CASCADE_APP_ID")),
  onEvent: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })),
});
await settler.run(Number(process.env.SETTLER_INTERVAL_MS ?? 5000));
