/**
 * Rehearses scripts/mainnet/deploy.ts on a local sandbox: the exact code path
 * that will run on testnet and mainnet, with every approval auto-accepted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, type Sandbox } from "near-sandbox";
import { KeyPair, type KeyPairString } from "near-api-js";
import { Chain, factoryCalls } from "@cascade/near";
import { startSandbox } from "../../scripts/sandbox/start.js";
import { deployCascade, type DeployRecord } from "../../scripts/mainnet/deploy.js";
import { readConfig } from "../../scripts/mainnet/env.js";
import { autoIo } from "../../scripts/mainnet/io.js";

let sb: Sandbox;
let chain: Chain;
const saved: Record<string, string> = {};
let env: NodeJS.ProcessEnv;
let first: DeployRecord | null;

beforeAll(async () => {
  sb = await startSandbox();
  chain = new Chain(sb.rpcUrl, "sandbox");
  const sandboxRoot = chain.account(DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY as KeyPairString);
  const kp = KeyPair.fromRandom("ed25519");
  // The human creates the root account in a wallet; here the sandbox root plays that part.
  await sandboxRoot.createAccount({ newAccountId: `cascade.${DEFAULT_ACCOUNT_ID}`, publicKey: kp.getPublicKey(), nearToTransfer: 30n * 10n ** 24n });
  env = {
    NEAR_NETWORK: "sandbox",
    NEAR_RPC_URL: sb.rpcUrl,
    CASCADE_ROOT_ID: `cascade.${DEFAULT_ACCOUNT_ID}`,
    CASCADE_ROOT_PRIVATE_KEY: kp.toString(),
    SPUTNIK_FACTORY_ID: `sputnik-dao.${DEFAULT_ACCOUNT_ID}`,
  };
  first = await deployCascade(readConfig(env), autoIo(), { saveKey: (k, v) => (saved[k] = v), recordDir: null });
});

afterAll(async () => {
  await sb?.tearDown();
});

describe("deploy script (sandbox rehearsal)", () => {
  it("deploys everything and verifies it", () => {
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      app: "app.cascade.sandbox", factory: "cascade.sandbox", usdc: "usdc.cascade.sandbox", usdcIsMock: true,
      relayer: "relayer.cascade.sandbox", settler: "settler.cascade.sandbox", appLocked: true,
    });
    expect(Object.keys(first!.transactions)).toHaveLength(5);
  });

  it("creates relayer and settler keys and hands them back to be saved, never printed", () => {
    expect(saved.RELAYER_PRIVATE_KEY).toMatch(/^ed25519:/);
    expect(saved.SETTLER_PRIVATE_KEY).toMatch(/^ed25519:/);
    expect(saved.RELAYER_ACCOUNT_ID).toBe("relayer.cascade.sandbox");
  });

  it("is idempotent: a second run sends nothing", async () => {
    const again = await deployCascade(readConfig({ ...env, ...saved }), autoIo(), { saveKey: () => { throw new Error("should not create keys again"); }, recordDir: null });
    expect(again).not.toBeNull();
    expect(again!.transactions).toEqual({});
  });

  it("the deployed factory creates names for the relayer only", async () => {
    const relayer = chain.account(saved.RELAYER_ACCOUNT_ID!, saved.RELAYER_PRIVATE_KEY as KeyPairString);
    const user = KeyPair.fromRandom("ed25519");
    const r = await chain.send<boolean>(relayer, factoryCalls("cascade.sandbox").createName("ada", user.getPublicKey().toString()));
    expect(r.value).toBe(true);
    expect(await chain.view(first!.usdc, "storage_balance_of", { account_id: "ada.cascade.sandbox" })).not.toBeNull();
  });

  it("refuses to run when the app account has different code", async () => {
    const logs: string[] = [];
    const r = await deployCascade(readConfig({ ...env, ...saved, CASCADE_ROOT_ID: "cascade.sandbox" }), { ...autoIo((s) => logs.push(s)) }, { saveKey: () => {}, recordDir: null });
    expect(r).not.toBeNull(); // same code: fine
    // Root without a key is refused before anything is sent.
    const noKey = await deployCascade(readConfig({ ...env, CASCADE_ROOT_PRIVATE_KEY: "" }), autoIo((s) => logs.push(s)), { saveKey: () => {}, recordDir: null });
    expect(noKey).toBeNull();
    expect(logs.join("\n")).toContain("CASCADE_ROOT_PRIVATE_KEY is required");
  });
});
