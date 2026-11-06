/**
 * Cascade's backend, assembled once and hosted two ways: the Node server
 * (services/server, SQLite, a settler loop) and the Cloudflare Worker
 * (services/worker, D1, a cron trigger). Both call `createPlatform`, so the
 * routes, policies and money logic are the same code.
 *
 *   /health
 *   /v1/...          checkout API
 *   /relayer/...     fee-free actions (NEP-366) and name sign-up
 *   /api/shop/...    the demo merchant (only with shop credentials)
 *   settler          `platform.settler.tick()`, driven by the host
 */
import { Hono } from "hono";
import type { Limiter } from "@cascade/core";
import { StoreLimiter, type Store } from "@cascade/db";
import { AgentPayments, Billing, Checkout, Refunds, checkoutHooks, mintingDriver } from "@cascade/engine";
import { Chain } from "@cascade/near";
import { HttpOneClick, MockOneClick, type MockRecords, type OneClick } from "@cascade/oneclick";
import { apiApp } from "@cascade/api";
import { Relayer, relayerApp } from "@cascade/relayer";
import { Settler, nearSettlerChain, type SettlerEvent } from "@cascade/settler";
import type { ServerConfig } from "./config.js";
import { accessApp } from "./access.js";
import { shopApp, type ShopOrders, MemoryShopOrders } from "./shop.js";

export interface PlatformDeps {
  cfg: ServerConfig;
  store: Store;
  /** Rate limits. Default: in the store (correct with any number of instances). */
  limiter?: Limiter;
  /** Testnet demo mode: where the simulated 1Click keeps its quotes (default: memory). */
  mockRecords?: MockRecords;
  /** Seed for simulated deposit addresses. Must differ between instances that share mockRecords. */
  mockSeed?: string;
  shopOrders?: ShopOrders;
  /** Header carrying the client IP set by the platform ("cf-connecting-ip"). */
  ipHeader?: string;
  /** Outbound fetch (default: global fetch). Calls to this deployment's own origin never use it, see below. */
  fetch?: typeof fetch;
  onSettlerEvent?: (e: SettlerEvent) => void;
}

export interface Platform {
  app: Hono;
  settler: Settler;
  checkout: Checkout;
  /** Set in testnet demo mode only. */
  mock: MockOneClick | null;
}

export function createPlatform(d: PlatformDeps): Platform {
  const { cfg, store } = d;
  // Calls to this deployment's own URL (webhooks to the demo shop, the shop's
  // calls to the API) are handled in-process: a Cloudflare Worker cannot fetch
  // its own URL, and on Node it saves a round trip.
  const origin = new URL(cfg.publicUrl).origin;
  const outbound = d.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const f: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    return new URL(req.url).origin === origin ? app.fetch(req) : outbound(req);
  };
  const chain = new Chain(cfg.rpc, cfg.network);
  // Testnet demo: NEAR Intents has no testnet, so the swap is simulated and the
  // "delivery" mints testnet mock USDC. Everything else is real testnet state.
  const mock =
    cfg.oneclick.mode === "mock"
      ? new MockOneClick({
          driver: mintingDriver(chain, chain.account(cfg.oneclick.minter.id, cfg.oneclick.minter.key), cfg.usdc),
          authenticated: true,
          seed: d.mockSeed ?? `testnet-${Date.now()}`,
          ...(d.mockRecords ? { records: d.mockRecords } : {}),
        })
      : null;
  const oneclick: OneClick = mock ?? new HttpOneClick(cfg.oneclickJwt ? { jwt: cfg.oneclickJwt } : {});
  const checkout = new Checkout({
    store, oneclick, chain, app: cfg.app, publicUrl: cfg.publicUrl, keyMode: cfg.network === "mainnet" ? "live" : "test",
    usdc: cfg.usdc, relayer: cfg.relayer.id,
    ...(cfg.fee ? { fee: cfg.fee } : {}),
  });
  const refunds = new Refunds(checkout);
  const billing = new Billing(checkout);
  const limiter = d.limiter ?? new StoreLimiter(store);
  const relayer = new Relayer({
    chain, payer: chain.account(cfg.relayer.id, cfg.relayer.key), app: cfg.app, usdc: cfg.usdc, factory: cfg.factory, daoFactory: cfg.daoFactory, limiter,
  });
  const settler = new Settler({
    oneclick, store, chain: nearSettlerChain(chain, chain.account(cfg.settler.id, cfg.settler.key), cfg.app),
    hooks: checkoutHooks(checkout, f, refunds, billing),
    ...(d.onSettlerEvent ? { onEvent: d.onSettlerEvent } : {}),
  });

  const ipHeader = d.ipHeader ? { ipHeader: d.ipHeader } : {};
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, network: cfg.network, app: cfg.app, oneclick: mock ? "simulated" : "live" }));
  app.route("/relayer", relayerApp(relayer, { trustProxy: cfg.trustProxy, allowOrigins: cfg.allowOrigins, ...ipHeader }));
  app.route("/api", accessApp({ checkout, relayer, chain, app: cfg.app, store, limiter, sandbox: cfg.oneclick.mode === "mock", ...ipHeader }));
  app.route("/api/shop", shopApp({ credentials: cfg.shop, orders: d.shopOrders ?? new MemoryShopOrders(), apiUrl: cfg.publicUrl, fetch: f }));
  app.route("/", apiApp({ checkout, refunds, billing, agents: new AgentPayments(checkout), trustProxy: cfg.trustProxy, limiter, ...ipHeader, ...(mock ? { dev: { oneclick: mock } } : {}) }));
  return { app, settler, checkout, mock };
}
