/** Node wrapper: reads the deployment record from disk, then the shared parser. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, type ServerConfig } from "@cascade/platform";

export { ConfigError, type ServerConfig } from "@cascade/platform";

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): ServerConfig {
  const network = env.NEAR_NETWORK ?? "testnet";
  const file = resolve(root, env.CASCADE_DEPLOYMENT ?? `deployments/${network}.json`);
  const dep = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  return parseConfig(env, dep, file);
}
