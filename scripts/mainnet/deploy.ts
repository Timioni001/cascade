/**
 * pnpm deploy:cascade [--dry-run]
 *
 * Deploys Cascade to the network in .env (testnet first, then mainnet):
 *   <root>            name factory  (names are <name>.<root>)
 *   app.<root>        app contract, LOCKED: created with no access key, so
 *                     nobody (including us) can redeploy it or move its funds
 *   relayer.<root>    pays users' gas   (created for you if missing)
 *   settler.<root>    records payments  (created for you if missing)
 *   usdc.<root>       mock USDC, testnet/sandbox only (mainnet uses real USDC)
 *
 * Every transaction is shown and needs a typed "yes". Re-running is safe:
 * finished steps are detected and skipped. Results go to deployments/<network>.json.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, actions, type Account, type Action } from "near-api-js";
import { Chain, parseOutcome } from "@cascade/near";
import { describeActions, type Io } from "./io.js";
import { loadEnv, maskKey, near, readConfig, saveKeyToEnv, type NetConfig } from "./env.js";

const here = dirname(fileURLToPath(import.meta.url));
export const RES_DIR = resolve(here, "../../contracts/res");
export const DEPLOY_DIR = resolve(here, "../../deployments");
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

export const FUNDING = {
  /** Headroom on top of the code's storage: state growth and USDC registrations paid while executing batches. */
  appHeadroom: 2n * NEAR,
  relayer: 3n * NEAR,
  settler: 1n * NEAR,
  mockUsdc: 3n * NEAR,
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** NEAR storage staking: 10^19 yoctoNEAR per byte (1 NEAR per 100 kB). */
export function storageCost(bytes: number): bigint {
  return BigInt(bytes) * 10n ** 19n;
}

/** What the app account is funded with: its code's storage plus headroom. */
export function appFunding(wasmBytes: number): bigint {
  return storageCost(wasmBytes) + FUNDING.appHeadroom;
}

/** NEAR's code_hash: base58(sha256(wasm)). */
export function codeHash(wasm: Uint8Array): string {
  return bs58(createHash("sha256").update(wasm).digest());
}

const NO_CODE = "11111111111111111111111111111111";

interface AccountView {
  amount: string;
  code_hash: string;
}

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cascade", method, params }) });
  const j = (await r.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string; data?: unknown } };
  if (j.error) {
    const e = new Error(`${method}: ${j.error.cause?.name ?? j.error.message ?? "rpc error"}`) as Error & { cause_name?: string };
    e.cause_name = j.error.cause?.name;
    throw e;
  }
  return j.result as T;
}

async function viewAccount(url: string, id: string): Promise<AccountView | null> {
  try {
    return await rpc<AccountView>(url, "query", { request_type: "view_account", finality: "optimistic", account_id: id });
  } catch (e) {
    if ((e as { cause_name?: string }).cause_name === "UNKNOWN_ACCOUNT") return null;
    throw e;
  }
}

function wasm(name: string): Uint8Array {
  const bytes = readFileSync(join(RES_DIR, name));
  const sums = readFileSync(join(RES_DIR, "SHA256SUMS"), "utf8");
  const want = sums.split("\n").find((l) => l.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (want !== got) throw new Error(`${name} does not match contracts/res/SHA256SUMS; rebuild with pnpm build:contracts`);
  return bytes;
}

export interface DeployRecord {
  network: string;
  root: string;
  factory: string;
  app: string;
  usdc: string;
  usdcIsMock: boolean;
  relayer: string;
  settler: string;
  daoFactory: string;
  codeHashes: { app: string; factory: string; mockUsdc?: string };
  appLocked: boolean;
  transactions: Record<string, string>;
  updatedAt: string;
}

export interface DeployOptions {
  /** Persist a generated key (CLI: append to .env). */
  saveKey: (envName: string, value: string) => void;
  /** Where to write the deployment record; null = don't write. */
  recordDir: string | null;
}

class Stop extends Error {}

export async function deployCascade(cfg: NetConfig, io: Io, opts: DeployOptions): Promise<DeployRecord | null> {
  const chain = new Chain(cfg.rpc, cfg.network);
  const txs: Record<string, string> = {};
  const view = (id: string) => viewAccount(cfg.rpc, id);

  async function send(signer: Account, title: string, receiver: string, acts: Action[], spendNear?: bigint, extra: string[] = []): Promise<string> {
    const ok = await io.approve({ title, signer: signer.accountId, receiver, details: [...extra, ...describeActions(acts)], ...(spendNear !== undefined ? { spendNear } : {}) });
    if (!ok) throw new Stop(`not approved: ${title}`);
    const raw = await signer.signAndSendTransaction({ receiverId: receiver, actions: acts, waitUntil: "FINAL", throwOnFailure: false });
    const r = parseOutcome(raw as never);
    if (!r.ok || r.error) throw new Error(`${title} failed (tx ${r.hash}): ${r.error ?? "unknown"}`);
    txs[title] = r.hash;
    io.log(`✓ ${title}: tx ${r.hash}`);
    return r.hash;
  }

  try {
    // ------------------------------------------------------------ preflight
    io.step(`Preflight (${cfg.network}, ${cfg.rpc})`);
    if (cfg.network !== "sandbox") {
      const status = await rpc<{ chain_id: string }>(cfg.rpc, "status", []);
      if (status.chain_id !== cfg.network) throw new Stop(`RPC ${cfg.rpc} is on ${status.chain_id}, but NEAR_NETWORK=${cfg.network}`);
    }
    if (!cfg.root.key) throw new Stop("CASCADE_ROOT_PRIVATE_KEY is required to deploy");
    const rootView = await view(cfg.root.id);
    if (!rootView) throw new Stop(`${cfg.root.id} does not exist on ${cfg.network}. Create it in a wallet first (Cascade never creates your accounts).`);
    const root = chain.account(cfg.root.id, cfg.root.key);
    const rootPk = KeyPair.fromString(cfg.root.key).getPublicKey();
    io.log(`root ${cfg.root.id}: ${near(BigInt(rootView.amount))}, key ${maskKey(cfg.root.key)}`);
    if (cfg.network === "mainnet" && !cfg.usdc) throw new Stop("mainnet needs USDC_CONTRACT_ID (the real USDC); the mock token is never deployed to mainnet");

    const appWasm = wasm("cascade_app.wasm");
    const factoryWasm = wasm("cascade_factory.wasm");
    const hashes = { app: codeHash(appWasm), factory: codeHash(factoryWasm) } as DeployRecord["codeHashes"];

    // ------------------------------------------------------------ relayer + settler
    for (const [role, acc, fund, envKey] of [
      ["relayer", cfg.relayer, FUNDING.relayer, "RELAYER"],
      ["settler", cfg.settler, FUNDING.settler, "SETTLER"],
    ] as const) {
      io.step(`${role}: ${acc.id}`);
      const v = await view(acc.id);
      if (v) {
        if (!acc.key) throw new Stop(`${acc.id} exists but ${envKey}_PRIVATE_KEY is not set`);
        io.log(`exists, ${near(BigInt(v.amount))}`);
        continue;
      }
      if (acc.key) throw new Stop(`${envKey}_PRIVATE_KEY is set but ${acc.id} does not exist`);
      if (!acc.id.endsWith(`.${cfg.root.id}`)) throw new Stop(`${acc.id} does not exist and is not a sub-account of ${cfg.root.id}, so it cannot be created here`);
      const kp = KeyPair.fromRandom("ed25519");
      await send(root, `create ${role} account`, acc.id, [actions.createAccount(), actions.transfer(fund), actions.addFullAccessKey(kp.getPublicKey())], fund, [
        `new key ${kp.getPublicKey().toString()} (private key saved to .env as ${envKey}_PRIVATE_KEY)`,
      ]);
      opts.saveKey(`${envKey}_ACCOUNT_ID`, acc.id);
      opts.saveKey(`${envKey}_PRIVATE_KEY`, kp.toString());
      (acc as { key: string | null }).key = kp.toString();
    }

    // ------------------------------------------------------------ token
    let usdc = cfg.usdc;
    let usdcIsMock = false;
    io.step("Token");
    if (usdc) {
      const meta = await chain.view<{ symbol: string; decimals: number }>(usdc, "ft_metadata");
      if (meta.decimals !== 6) throw new Stop(`${usdc} has ${meta.decimals} decimals, expected 6`);
      io.log(`${usdc}: ${meta.symbol}, 6 decimals`);
    } else {
      usdc = `usdc.${cfg.root.id}`;
      usdcIsMock = true;
      const mockWasm = wasm("mock_usdc.wasm");
      hashes.mockUsdc = codeHash(mockWasm);
      const v = await view(usdc);
      if (!v) {
        io.warn(`no USDC on ${cfg.network}: deploying the mock token to ${usdc} (minter: ${cfg.root.id})`);
        await send(root, "create mock USDC", usdc, [
          actions.createAccount(), actions.transfer(FUNDING.mockUsdc), actions.addFullAccessKey(rootPk),
          actions.deployContract(mockWasm), actions.functionCall("new", { minter: cfg.root.id }, 30n * TGAS, 0n),
        ], FUNDING.mockUsdc);
      } else if (v.code_hash !== hashes.mockUsdc) {
        throw new Stop(`${usdc} exists with different code`);
      } else io.log(`${usdc}: mock USDC already deployed`);
    }

    // ------------------------------------------------------------ app (locked)
    io.step(`App contract: ${cfg.app}`);
    const appView = await view(cfg.app);
    const appInit = { admin: cfg.root.id, settler: cfg.settler.id, token: usdc, dao_factory: cfg.daoFactory };
    if (!appView) {
      await send(root, "create, deploy and init app (locked: no access key)", cfg.app, [
        actions.createAccount(), actions.transfer(appFunding(appWasm.length)), actions.deployContract(appWasm),
        actions.functionCall("new", appInit, 100n * TGAS, 0n),
      ], appFunding(appWasm.length), ["no access key is added: the contract can never be changed or drained by anyone"]);
    } else if (appView.code_hash === hashes.app) {
      io.log("already deployed with this exact code");
    } else {
      throw new Stop(`${cfg.app} exists with different code (${appView.code_hash}). The app is locked by design; deploy a new app account to upgrade.`);
    }

    // ------------------------------------------------------------ factory on root
    io.step(`Name factory: ${cfg.root.id}`);
    const rv = (await view(cfg.root.id))!;
    if (rv.code_hash === NO_CODE) {
      await send(root, "deploy and init name factory", cfg.root.id, [
        actions.deployContract(factoryWasm),
        actions.functionCall("new", { admin: cfg.root.id, relayer: cfg.relayer.id, app: cfg.app, token: usdc, daily_cap: cfg.dailyNameCap }, 50n * TGAS, 0n),
      ]);
    } else if (rv.code_hash === hashes.factory) {
      io.log("already deployed with this exact code");
    } else {
      throw new Stop(`${cfg.root.id} already has other code (${rv.code_hash}); use a dedicated account for Cascade`);
    }

    // ------------------------------------------------------------ verify
    io.step("Verify");
    const appCfg = await chain.view<{ settler: string; token: string; dao_factory: string }>(cfg.app, "get_config");
    const facCfg = await chain.view<{ relayer: string; app: string; token: string }>(cfg.root.id, "get_config");
    const reg = await chain.view<unknown>(usdc, "storage_balance_of", { account_id: cfg.app });
    const appKeys = await rpc<{ keys: unknown[] }>(cfg.rpc, "query", { request_type: "view_access_key_list", finality: "optimistic", account_id: cfg.app });
    const checks: [boolean, string][] = [
      [appCfg.settler === cfg.settler.id && appCfg.token === usdc && appCfg.dao_factory === cfg.daoFactory, "app config (settler, token, DAO factory)"],
      [facCfg.relayer === cfg.relayer.id && facCfg.app === cfg.app && facCfg.token === usdc, "factory config (relayer, app, token)"],
      [reg !== null, "app is registered with the token"],
      [appKeys.keys.length === 0, "app account has no access keys (locked)"],
    ];
    let allOk = true;
    for (const [ok, what] of checks) {
      io.log(`${ok ? "✓" : "✗"} ${what}`);
      allOk &&= ok;
    }
    if (!allOk) throw new Error("verification failed; see above");

    const record: DeployRecord = {
      network: cfg.network, root: cfg.root.id, factory: cfg.root.id, app: cfg.app, usdc, usdcIsMock,
      relayer: cfg.relayer.id, settler: cfg.settler.id, daoFactory: cfg.daoFactory, codeHashes: hashes,
      appLocked: appKeys.keys.length === 0, transactions: txs, updatedAt: new Date().toISOString(),
    };
    if (opts.recordDir) {
      mkdirSync(opts.recordDir, { recursive: true });
      const file = join(opts.recordDir, `${cfg.network}.json`);
      let prev: Partial<DeployRecord> = {};
      try {
        prev = JSON.parse(readFileSync(file, "utf8")) as DeployRecord;
      } catch {
        /* first deploy */
      }
      writeFileSync(file, JSON.stringify({ ...record, transactions: { ...(prev.transactions ?? {}), ...txs } }, null, 2) + "\n");
      io.log(`wrote ${file}`);
    }
    return record;
  } catch (e) {
    if (e instanceof Stop) {
      io.warn(e.message);
      return null;
    }
    throw e;
  }
}

// ------------------------------------------------------------ CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { cliIo } = await import("./io.js");
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  const cfg = readConfig();
  const io = cliIo({ network: cfg.network, dryRun });
  try {
    const r = await deployCascade(cfg, io, { saveKey: saveKeyToEnv, recordDir: dryRun ? null : DEPLOY_DIR });
    if (r) {
      io.step("Done");
      io.log(`app ${r.app} · factory ${r.factory} · token ${r.usdc}${r.usdcIsMock ? " (mock)" : ""}`);
      io.log("Next: set CASCADE_APP_ID, CASCADE_FACTORY_ID and USDC_CONTRACT_ID in .env from deployments/" + `${r.network}.json`);
    } else process.exitCode = dryRun ? 0 : 1;
  } finally {
    io.close();
  }
}
