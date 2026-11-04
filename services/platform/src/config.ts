/**
 * Platform configuration: contract ids from the deployment record
 * (deployments/<network>.json, written by `pnpm deploy:cascade`), secrets and
 * URLs from the environment. Pure (no filesystem), so the Node server and the
 * Cloudflare Worker share it. Fails fast with a message that says exactly
 * what is missing.
 */
import type { KeyPairString } from "near-api-js";

export type Env = Record<string, string | undefined>;
export type Deployment = Record<string, unknown>;

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
  /**
   * "mock": testnet demo only. 1Click is simulated and deliveries mint the
   * testnet mock USDC (the deploy script makes the root account its minter).
   */
  oneclick: { mode: "live" } | { mode: "mock"; minter: { id: string; key: KeyPairString } };
  fee: { recipient: string; bps: number } | null;
  publicUrl: string;
  allowOrigins: string[];
  dbPath: string;
  port: number;
  trustProxy: boolean;
  settlerIntervalMs: number;
  /** The built-in demo shop's merchant credentials (`pnpm demo-merchant` prints them). Null: the shop answers 503. */
  shop: { secretKey: string; webhookSecret: string } | null;
}

const RPC = { mainnet: "https://rpc.mainnet.fastnear.com", testnet: "https://rpc.testnet.fastnear.com" };

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** `dep` is the deployment record (or {}); `depLabel` names it in error messages. */
export function parseConfig(env: Env, dep: Deployment = {}, depLabel = "deployments/<network>.json"): ServerConfig {
  const network = env.NEAR_NETWORK as ServerConfig["network"] | undefined;
  if (network !== "mainnet" && network !== "testnet") throw new ConfigError("NEAR_NETWORK must be mainnet or testnet");
  // Safety first: a simulated 1Click must never run against real money.
  const oneclickSetting = env.CASCADE_ONECLICK?.trim() || "live";
  if (oneclickSetting !== "live" && oneclickSetting !== "mock") throw new ConfigError("CASCADE_ONECLICK must be live or mock");
  if (oneclickSetting === "mock" && network !== "testnet") throw new ConfigError("CASCADE_ONECLICK=mock is only allowed on testnet");
  const file = depLabel;
  const depStr = (k: string) => (typeof dep[k] === "string" ? (dep[k] as string) : undefined);
  const pick = (envName: string, depKey: string) => env[envName]?.trim() || depStr(depKey);
  const need = (name: string, v: string | undefined) => {
    if (!v) throw new ConfigError(`missing ${name} (set it in the environment, or deploy first so ${file} exists)`);
    return v;
  };
  const key = (name: string) => {
    const v = need(name, env[name]?.trim());
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(v)) throw new ConfigError(`${name} is not an ed25519 private key`);
    return v as KeyPairString;
  };
  function oneclickMode(): ServerConfig["oneclick"] {
    if (oneclickSetting === "live") return { mode: "live" };
    if (dep.usdcIsMock !== true && !env.USDC_CONTRACT_ID) throw new ConfigError("mock mode needs the mock USDC from the testnet deployment");
    return { mode: "mock", minter: { id: need("CASCADE_ROOT_ID", env.CASCADE_ROOT_ID?.trim() || depStr("root")), key: key("CASCADE_ROOT_PRIVATE_KEY") } };
  }
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
    oneclick: oneclickMode(),
    fee: feeBps > 0 ? { recipient: need("CASCADE_FEE_RECIPIENT", env.CASCADE_FEE_RECIPIENT?.trim()), bps: feeBps } : null,
    publicUrl,
    allowOrigins: [publicUrl, ...(env.CASCADE_ALLOW_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])],
    dbPath: env.CASCADE_DB?.trim() || ".data/cascade.sqlite",
    port: Number(env.PORT ?? env.API_PORT ?? 8788),
    trustProxy: env.TRUST_PROXY === "1",
    settlerIntervalMs: Number(env.SETTLER_INTERVAL_MS ?? 5000),
    shop: shopConfig(env),
  };
}

function shopConfig(env: Env): ServerConfig["shop"] {
  const secretKey = env.CASCADE_SHOP_SECRET_KEY?.trim();
  const webhookSecret = env.CASCADE_SHOP_WEBHOOK_SECRET?.trim();
  if (!secretKey && !webhookSecret) return null;
  if (!secretKey?.startsWith("sk_") || !webhookSecret) throw new ConfigError("set both CASCADE_SHOP_SECRET_KEY (sk_...) and CASCADE_SHOP_WEBHOOK_SECRET, or neither");
  return { secretKey, webhookSecret };
}
