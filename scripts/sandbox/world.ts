/**
 * A complete Cascade deployment inside a local sandbox: the real app,
 * factory and Sputnik DAO contracts, a mock USDC, an in-process relayer and
 * settler, and MockOneClick driving real token balances.
 *
 * Used by `pnpm demo` and by the sandbox test suite (contracts/tests).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, type Sandbox } from "near-sandbox";
import { KeyPair, actions, type Account, type KeyPairString } from "near-api-js";
import { MemoryStore } from "@cascade/db";
import { Billing, Checkout, Engine, Refunds, checkoutHooks, mintingDriver, directExecutor, expectOk, gaslessExecutor, type Executor, type RelaySink } from "@cascade/engine";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { apiApp } from "@cascade/api";
import { Chain, ftCalls, type TxResult } from "@cascade/near";
import { MockOneClick } from "@cascade/oneclick";
import { daoInitArgs, payrollPolicy } from "@cascade/sputnik";
import { Relayer } from "@cascade/relayer";
import { Settler, nearSettlerChain } from "@cascade/settler";
import { startSandbox } from "./start.js";

const here = dirname(fileURLToPath(import.meta.url));
export const RES = resolve(here, "../../contracts/res");
const NEAR = 10n ** 24n;

export const ROOT = DEFAULT_ACCOUNT_ID; // "sandbox"
export const ids = {
  factory: `cascade.${ROOT}`, // names live here: ada.cascade.sandbox
  app: `app.cascade.${ROOT}`,
  usdc: `usdc.${ROOT}`,
  relayer: `relayer.${ROOT}`,
  settler: `settler.${ROOT}`,
  solver: `solver.${ROOT}`, // mints mock USDC, plays the 1Click solver
  daoFactory: `sputnik-dao.${ROOT}`,
};

export interface Person {
  id: string;
  full: Account; // full-access key: browser-held, used only when a deposit is attached
  app: Account; // function-call key limited to the app contract (or the same full key for plain accounts)
  key: KeyPair;
  gasless: Executor; // signs with `app` key, relayer pays
  gaslessFull: Executor; // signs with full key, relayer pays (needed for 1-yocto deposits)
}

export interface World {
  sandbox: Sandbox;
  chain: Chain;
  root: Account;
  oneclick: MockOneClick;
  store: MemoryStore;
  engine: Engine;
  relayer: Relayer;
  sink: RelaySink;
  settler: Settler;
  checkout: Checkout;
  refunds: Refunds;
  billing: Billing;
  /** Base URL of the checkout API served from this process, e.g. http://127.0.0.1:41234 */
  apiUrl: string;
  as: (account: Account) => Executor;
  usdcBalance: (account: string) => Promise<bigint>;
  nearBalance: (account: string) => Promise<bigint>;
  /** Sign up through the factory, exactly like the web app does. */
  signUp: (name: string) => Promise<Person>;
  /** A plain sandbox account (no factory), for approvers and recipients. */
  plainAccount: (name: string, near?: bigint) => Promise<Person>;
  createDao: (name: string, policy: ReturnType<typeof payrollPolicy>) => Promise<string>;
  /** Freeze an account on the mock USDC, like Circle can on real USDC. */
  freeze: (account: string) => Promise<void>;
  /** Run settler passes until nothing happens (or `max`). */
  settle: (max?: number) => Promise<import("@cascade/settler").SettlerEvent[]>;
  /**
   * Environment for the real platform (services/platform: Node server or
   * Cloudflare Worker) pointed at this sandbox, in testnet demo mode with the
   * solver as the mock USDC minter.
   */
  platformEnv: (publicUrl: string) => Record<string, string>;
  stop: () => Promise<void>;
}

function wasm(name: string): Uint8Array {
  return readFileSync(join(RES, name));
}

export async function createWorld(opts: { log?: (s: string) => void; apiPort?: number; publicUrl?: string } = {}): Promise<World> {
  const log = opts.log ?? (() => {});
  const sandbox = await startSandbox();
  const chain = new Chain(sandbox.rpcUrl, "sandbox");
  const root = chain.account(ROOT, DEFAULT_PRIVATE_KEY as KeyPairString);
  const direct = (a: Account) => directExecutor(chain, a);

  const keys = new Map<string, KeyPair>();
  async function sub(parent: Account, id: string, near: bigint): Promise<Account> {
    const kp = KeyPair.fromRandom("ed25519");
    keys.set(id, kp);
    const r = await parent.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near });
    if ((r as { status: { Failure?: unknown } }).status.Failure) throw new Error(`create ${id} failed`);
    return chain.account(id, kp);
  }

  log("deploying contracts");
  const factory = await sub(root, ids.factory, 50n * NEAR);
  const app = await sub(factory, ids.app, 20n * NEAR);
  const usdc = await sub(root, ids.usdc, 10n * NEAR);
  const relayerAcc = await sub(root, ids.relayer, 50n * NEAR);
  const settlerAcc = await sub(root, ids.settler, 20n * NEAR);
  const solver = await sub(root, ids.solver, 10n * NEAR);
  const daoFactory = await sub(root, ids.daoFactory, 100n * NEAR);

  await usdc.deployContract(wasm("mock_usdc.wasm"));
  expectOk(await chain.send(usdc, { receiverId: ids.usdc, label: "init usdc", actions: [fnInit("new", { minter: ids.solver })] }), "init usdc");
  await app.deployContract(wasm("cascade_app.wasm"));
  expectOk(
    await chain.send(app, {
      receiverId: ids.app, label: "init app",
      actions: [fnInit("new", { admin: ids.factory, settler: ids.settler, token: ids.usdc, dao_factory: ids.daoFactory })],
    }),
    "init app",
  );
  await factory.deployContract(wasm("cascade_factory.wasm"));
  expectOk(
    await chain.send(factory, {
      receiverId: ids.factory, label: "init factory",
      actions: [fnInit("new", { admin: ids.factory, relayer: ids.relayer, app: ids.app, token: ids.usdc })],
    }),
    "init factory",
  );

  const store = new MemoryStore();
  const usdcBalance = (a: string) => chain.ftBalance(ids.usdc, a);
  // The solver account mints mock USDC where 1Click would deliver real USDC.
  const driver = mintingDriver(chain, solver, ids.usdc);
  // `authenticated: true` = behave as if a 1Click partner JWT is configured,
  // which is what enables Confidential Intents for private lines.
  const oneclick = new MockOneClick({ driver, authenticated: true, seed: `demo-${Date.now()}` });
  const engine = new Engine({ chain, oneclick, store, app: ids.app, usdc: ids.usdc, publicUrl: "https://cascade.link" });
  const relayer = new Relayer({
    chain, payer: relayerAcc, app: ids.app, usdc: ids.usdc, factory: ids.factory, daoFactory: ids.daoFactory,
    limits: { namesPerIp: { max: 100, windowMs: 86_400_000 }, relayPerIp: { max: 10_000, windowMs: 3_600_000 }, relayPerAccount: { max: 1_000, windowMs: 3_600_000 } },
  });
  const sink: RelaySink = { relay: (b64) => relayer.relay(b64, { ip: "127.0.0.1" }) };
  // 0.5% Cascade fee (the published price), paid by customers into an Intents account (shown on the checkout page).
  const checkout = new Checkout({
    store, oneclick, chain, app: ids.app, publicUrl: opts.publicUrl ?? "http://localhost:3000", fee: { recipient: ids.factory, bps: 50 }, usdc: ids.usdc, relayer: ids.relayer,
  });
  const refunds = new Refunds(checkout);
  const billing = new Billing(checkout);
  const settler = new Settler({ oneclick, store, chain: nearSettlerChain(chain, settlerAcc, ids.app), hooks: checkoutHooks(checkout, fetch, refunds, billing) });
  const server = serve({ fetch: apiApp({ checkout, refunds, billing, dev: { oneclick } }).fetch, port: opts.apiPort ?? 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function signUp(name: string): Promise<Person> {
    const full = KeyPair.fromRandom("ed25519");
    const appKey = KeyPair.fromRandom("ed25519");
    const r = await relayer.createName({ name, publicKey: full.getPublicKey().toString(), appKey: appKey.getPublicKey().toString() }, { ip: "127.0.0.1" });
    const fullAcc = chain.account(r.accountId, full);
    const appAcc = chain.account(r.accountId, appKey);
    return { id: r.accountId, full: fullAcc, app: appAcc, key: full, gasless: gaslessExecutor(appAcc, sink), gaslessFull: gaslessExecutor(fullAcc, sink) };
  }

  async function plainAccount(name: string, near = 1n * NEAR): Promise<Person> {
    const id = `${name}.${ROOT}`;
    const a = await sub(root, id, near);
    const g = gaslessExecutor(a, sink);
    return { id, full: a, app: a, key: keys.get(id)!, gasless: g, gaslessFull: g };
  }

  async function createDao(name: string, policy: ReturnType<typeof payrollPolicy>): Promise<string> {
    const id = `${name}.${ids.daoFactory}`;
    const dao = await sub(daoFactory, id, 10n * NEAR);
    await dao.deployContract(wasm("sputnikdao2.wasm"));
    expectOk(await chain.send(dao, { receiverId: id, label: "init dao", actions: [fnInit("new", daoInitArgs(name, "Cascade demo team", policy))] }), "init dao");
    return id;
  }

  async function settle(max = 12) {
    const all: import("@cascade/settler").SettlerEvent[] = [];
    for (let i = 0; i < max; i++) {
      const ev = await settler.tick();
      const errors = ev.filter((e) => e.type === "error");
      if (errors.length) throw new Error(`settler: ${JSON.stringify(errors)}`);
      all.push(...ev);
      if (ev.length === 0) break;
    }
    return all;
  }

  return {
    sandbox, chain, root, oneclick, store, engine, relayer, sink, settler, checkout, refunds, billing, apiUrl,
    as: direct,
    usdcBalance,
    nearBalance: (a) => chain.nearBalance(a),
    signUp, plainAccount, createDao, settle,
    platformEnv: (publicUrl) => ({
      NEAR_NETWORK: "testnet", NEAR_RPC_URL: sandbox.rpcUrl, CASCADE_PUBLIC_URL: publicUrl,
      CASCADE_APP_ID: ids.app, CASCADE_FACTORY_ID: ids.factory, USDC_CONTRACT_ID: ids.usdc, SPUTNIK_FACTORY_ID: ids.daoFactory,
      RELAYER_ACCOUNT_ID: ids.relayer, RELAYER_PRIVATE_KEY: keys.get(ids.relayer)!.toString(),
      SETTLER_ACCOUNT_ID: ids.settler, SETTLER_PRIVATE_KEY: keys.get(ids.settler)!.toString(),
      CASCADE_ONECLICK: "mock", CASCADE_ROOT_ID: ids.solver, CASCADE_ROOT_PRIVATE_KEY: keys.get(ids.solver)!.toString(),
      CASCADE_FEE_BPS: "50", CASCADE_FEE_RECIPIENT: ids.factory,
      // Lets `CASCADE_ADMIN_TOKEN=... pnpm dev` open /admin locally.
      ...(process.env.CASCADE_ADMIN_TOKEN ? { CASCADE_ADMIN_TOKEN: process.env.CASCADE_ADMIN_TOKEN } : {}),
    }),
    freeze: async (a) => {
      expectOk(await chain.send(solver, ftCalls(ids.usdc).setBlocked(a, true)), "freeze");
    },
    stop: async () => {
      // Never hang on shutdown: drop keep-alive connections, and give the
      // node 10 s to stop (on WSL its teardown can wait forever).
      const within = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await within(new Promise<void>((r) => server.close(() => r())), 3_000);
      await within(sandbox.tearDown().catch(() => undefined), 10_000);
    },
  };
}

function fnInit(method: string, args: object) {
  return actions.functionCall(method, args, 100n * 10n ** 12n, 0n);
}

export function lastValue<T>(r: TxResult<T>): T {
  if (r.value === undefined) throw new Error("no return value");
  return r.value;
}
