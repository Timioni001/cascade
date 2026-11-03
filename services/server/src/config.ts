/**
 * Server configuration: contract ids from deployments/<network>.json (written
 * by `pnpm deploy:cascade`), secrets and URLs from the environment.
 * Fails fast with a message that says exactly what is missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KeyPairString } from "near-api-js";

export interface ServerConfig {
  network: "mainnet" | "testnet";
  rpc: string;
  app: string;
  factory: string;
  usdc: string;
  daoFactory: string;
  relayer: { id: string; key: KeyPairString };
  settler: { id: string; key: KeyPairString };
  oneclickJwt: string | null;
  fee: { recipient: string; bps: number } | null;
  publicUrl: string;
  allowOrigins: string[];
  dbPath: string;
  port: number;
  trustProxy: boolean;
  settlerIntervalMs: number;
}

const RPC = { mainnet: "https://rpc.mainnet.fastnear.com", testnet: "https://rpc.testnet.fastnear.com" };

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): ServerConfig {
  const network = env.NEAR_NETWORK as ServerConfig["network"] | undefined;
  if (network !== "mainnet" && network !== "testnet") throw new ConfigError("NEAR_NETWORK must be mainnet or testnet");
  const file = resolve(root, env.CASCADE_DEPLOYMENT ?? `deployments/${network}.json`);
  const dep = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
  const pick = (envName: string, depKey: string) => env[envName]?.trim() || dep[depKey];
  const need = (name: string, v: string | undefined) => {
    if (!v) throw new ConfigError(`missing ${name} (set it in the environment, or deploy first so ${file} exists)`);
    return v;
  };
  const key = (name: string) => {
    const v = need(name, env[name]?.trim());
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(v)) throw new ConfigError(`${name} is not an ed25519 private key`);
    return v as KeyPairString;
  };
  const feeBps = Number(env.CASCADE_FEE_BPS ?? 0);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 200) throw new ConfigError("CASCADE_FEE_BPS must be an integer between 0 and 200");
  const publicUrl = need("CASCADE_PUBLIC_URL", env.CASCADE_PUBLIC_URL?.trim()).replace(/\/$/, "");
  return {
    network,
    rpc: env.NEAR_RPC_URL?.trim() || RPC[network],
    app: need("CASCADE_APP_ID", pick("CASCADE_APP_ID", "app")),
    factory: need("CASCADE_FACTORY_ID", pick("CASCADE_FACTORY_ID", "factory")),
    usdc: need("USDC_CONTRACT_ID", pick("USDC_CONTRACT_ID", "usdc")),
    daoFactory: need("SPUTNIK_FACTORY_ID", pick("SPUTNIK_FACTORY_ID", "daoFactory")),
    relayer: { id: need("RELAYER_ACCOUNT_ID", pick("RELAYER_ACCOUNT_ID", "relayer")), key: key("RELAYER_PRIVATE_KEY") },
    settler: { id: need("SETTLER_ACCOUNT_ID", pick("SETTLER_ACCOUNT_ID", "settler")), key: key("SETTLER_PRIVATE_KEY") },
    oneclickJwt: env.ONECLICK_JWT?.trim() || null,
    fee: feeBps > 0 ? { recipient: need("CASCADE_FEE_RECIPIENT", env.CASCADE_FEE_RECIPIENT?.trim()), bps: feeBps } : null,
    publicUrl,
    allowOrigins: [publicUrl, ...(env.CASCADE_ALLOW_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])],
    dbPath: env.CASCADE_DB?.trim() || ".data/cascade.sqlite",
    port: Number(env.PORT ?? env.API_PORT ?? 8788),
    trustProxy: env.TRUST_PROXY === "1",
    settlerIntervalMs: Number(env.SETTLER_INTERVAL_MS ?? 5000),
  };
}
