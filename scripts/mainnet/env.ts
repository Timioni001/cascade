/**
 * Configuration for scripts that touch a real network (testnet or mainnet).
 * Everything comes from `.env` (never committed). Private keys are only ever
 * read here and handed to a signer; they are never printed or logged.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KeyPairString } from "near-api-js";

export type Network = "mainnet" | "testnet" | "sandbox";

export const ENV_FILE = resolve(process.cwd(), ".env");

export const DEFAULTS: Record<Network, { rpc: string; usdc: string | null; daoFactory: string }> = {
  mainnet: {
    rpc: "https://rpc.mainnet.fastnear.com",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    daoFactory: "sputnik-dao.near",
  },
  // No official USDC we can mint on testnet: the deploy script installs the mock token.
  testnet: { rpc: "https://rpc.testnet.fastnear.com", usdc: null, daoFactory: "sputnikv2.testnet" },
  sandbox: { rpc: "http://127.0.0.1:3030", usdc: null, daoFactory: "sputnik-dao.sandbox" },
};

export interface Account_ {
  id: string;
  key: KeyPairString | null;
}

export interface NetConfig {
  network: Network;
  rpc: string;
  root: Account_; // e.g. cascade.near: hosts the name factory; names are <name>.<root>
  app: string; // app.<root>
  relayer: Account_;
  settler: Account_;
  usdc: string | null; // null = deploy the mock token (testnet/sandbox only)
  daoFactory: string;
  dailyNameCap: number;
  oneclickJwt: string | null;
  publicUrl: string | null;
}

/** Load .env into process.env (does not override variables already set). */
export function loadEnv(file = ENV_FILE): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

const KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/;

function key(env: NodeJS.ProcessEnv, name: string): KeyPairString | null {
  const v = env[name]?.trim();
  if (!v) return null;
  if (!KEY_RE.test(v)) throw new Error(`${name} does not look like an ed25519 private key (ed25519:...)`);
  return v as KeyPairString;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): NetConfig {
  const network = (env.NEAR_NETWORK ?? "testnet") as Network;
  if (!["mainnet", "testnet", "sandbox"].includes(network)) throw new Error(`NEAR_NETWORK must be mainnet, testnet or sandbox (got ${network})`);
  const d = DEFAULTS[network];
  const rootId = env.CASCADE_ROOT_ID?.trim();
  if (!rootId) throw new Error("CASCADE_ROOT_ID is required (the account that will host Cascade, e.g. cascade.near). Create it in a wallet first.");
  const suffix = network === "mainnet" ? ".near" : network === "testnet" ? ".testnet" : "";
  if (suffix && !rootId.endsWith(suffix)) throw new Error(`CASCADE_ROOT_ID ${rootId} is not a ${network} account`);
  return {
    network,
    rpc: env.NEAR_RPC_URL?.trim() || d.rpc,
    root: { id: rootId, key: key(env, "CASCADE_ROOT_PRIVATE_KEY") },
    app: `app.${rootId}`,
    relayer: { id: env.RELAYER_ACCOUNT_ID?.trim() || `relayer.${rootId}`, key: key(env, "RELAYER_PRIVATE_KEY") },
    settler: { id: env.SETTLER_ACCOUNT_ID?.trim() || `settler.${rootId}`, key: key(env, "SETTLER_PRIVATE_KEY") },
    usdc: env.USDC_CONTRACT_ID?.trim() || d.usdc,
    daoFactory: env.SPUTNIK_FACTORY_ID?.trim() || d.daoFactory,
    dailyNameCap: Number(env.FACTORY_DAILY_CAP ?? 50),
    oneclickJwt: env.ONECLICK_JWT?.trim() || null,
    publicUrl: env.CASCADE_PUBLIC_URL?.trim() || null,
  };
}

/**
 * Save a newly generated key to .env (created with mode 600). Used when the
 * deploy script creates the relayer and settler accounts for you.
 */
export function saveKeyToEnv(name: string, value: string, file = ENV_FILE): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (new RegExp(`^${name}=.+$`, "m").test(existing)) throw new Error(`${name} is already set in ${file}; refusing to overwrite a key`);
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  appendFileSync(file, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${name}=${value}\n`);
  chmodSync(file, 0o600);
  process.env[name] = value;
}

/** For logs: "ed25519:4Fz…(hidden)". Never print a whole key. */
export function maskKey(k: string): string {
  return `${k.slice(0, 12)}…(hidden)`;
}

export function near(yocto: bigint): string {
  const s = (Number(yocto) / 1e24).toFixed(4);
  return `${s} NEAR`;
}
