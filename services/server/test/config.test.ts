import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const KEY = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";
const base = { NEAR_NETWORK: "testnet", RELAYER_PRIVATE_KEY: KEY, SETTLER_PRIVATE_KEY: KEY, CASCADE_PUBLIC_URL: "https://cascade.example/" };

function repoWithDeployment(): string {
  const dir = mkdtempSync(join(tmpdir(), "cascade-cfg-"));
  mkdirSync(join(dir, "deployments"));
  writeFileSync(join(dir, "deployments", "testnet.json"), JSON.stringify({ app: "app.c.testnet", factory: "c.testnet", usdc: "usdc.c.testnet", relayer: "relayer.c.testnet", settler: "settler.c.testnet", daoFactory: "sputnikv2.testnet" }));
  return dir;
}

describe("server config", () => {
  it("reads contract ids from the deployment record and secrets from the env", () => {
    const c = loadConfig(base, repoWithDeployment());
    expect(c).toMatchObject({ app: "app.c.testnet", factory: "c.testnet", usdc: "usdc.c.testnet", relayer: { id: "relayer.c.testnet" }, publicUrl: "https://cascade.example", fee: null });
    expect(c.allowOrigins).toEqual(["https://cascade.example"]);
    expect(c.rpc).toBe("https://rpc.testnet.fastnear.com");
  });

  it("env overrides the deployment record", () => {
    expect(loadConfig({ ...base, CASCADE_APP_ID: "app2.c.testnet" }, repoWithDeployment()).app).toBe("app2.c.testnet");
  });

  it("testnet demo mode: simulated 1Click with the root as mock USDC minter; never on mainnet", () => {
    const dir = repoWithDeployment();
    const c = loadConfig({ ...base, CASCADE_ONECLICK: "mock", CASCADE_ROOT_ID: "c.testnet", CASCADE_ROOT_PRIVATE_KEY: KEY, USDC_CONTRACT_ID: "usdc.c.testnet" }, dir);
    expect(c.oneclick).toMatchObject({ mode: "mock", minter: { id: "c.testnet" } });
    expect(loadConfig(base, dir).oneclick).toEqual({ mode: "live" });
    expect(() => loadConfig({ ...base, NEAR_NETWORK: "mainnet", CASCADE_ONECLICK: "mock", CASCADE_ROOT_PRIVATE_KEY: KEY }, dir)).toThrow(/only allowed on testnet/);
    expect(() => loadConfig({ ...base, CASCADE_ONECLICK: "maybe" }, dir)).toThrow(/live or mock/);
  });

  it("fails with a clear message when something is missing or wrong", () => {
    expect(() => loadConfig({ ...base, NEAR_NETWORK: "sandbox" }, repoWithDeployment())).toThrow(/mainnet or testnet/);
    expect(() => loadConfig(base, mkdtempSync(join(tmpdir(), "empty-")))).toThrow(/CASCADE_APP_ID.*deploy first/);
    expect(() => loadConfig({ ...base, RELAYER_PRIVATE_KEY: "nope" }, repoWithDeployment())).toThrow(/not an ed25519/);
    expect(() => loadConfig({ ...base, CASCADE_FEE_BPS: "30" }, repoWithDeployment())).toThrow(/CASCADE_FEE_RECIPIENT/);
    expect(() => loadConfig({ ...base, CASCADE_FEE_BPS: "500", CASCADE_FEE_RECIPIENT: "x" }, repoWithDeployment())).toThrow(/between 0 and 200/);
  });
});
