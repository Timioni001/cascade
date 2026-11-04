import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { USDC_NEAR_ASSET } from "@cascade/core";
import { OneClickError, type OneClick } from "./client.js";
import type {
  ExecutionStatus, QuoteRequest, QuoteResponse, StatusResponse, SubmitDepositRequest, SwapDetails, Token,
} from "./types.js";

/**
 * A deterministic stand-in for 1Click, used by unit tests, the sandbox test
 * suite and `pnpm demo`. NEAR Intents has no testnet, so this is how the
 * whole flow runs without keys or money.
 *
 * It mirrors behaviour observed on the real API (docs/research.md):
 * - dry quotes carry no deposit address or deadline;
 * - confidential quotes are refused (401) without a partner JWT;
 * - without a JWT a 20 bps app fee is added.
 *
 * The `driver` connects it to a chain: incoming swaps deliver USDC by calling
 * `deliverUsdc` (the sandbox driver mints mock USDC), outgoing swaps complete
 * once `usdcBalance(depositAddress)` shows the deposit arrived.
 */
export interface MockDriver {
  /** Deliver USDC on NEAR. With `msg`, deliver via ft_transfer_call (1Click's customRecipientMsg). */
  deliverUsdc(recipient: string, amount: bigint, msg?: string): Promise<string>;
  usdcBalance(account: string): Promise<bigint>;
}

/** In-memory driver: a ledger of USDC balances with fake tx hashes. */
export class MemoryDriver implements MockDriver {
  readonly balances = new Map<string, bigint>();
  readonly messages: { recipient: string; amount: bigint; msg: string }[] = [];
  private n = 0;
  async deliverUsdc(recipient: string, amount: bigint, msg?: string) {
    if (msg !== undefined) this.messages.push({ recipient, amount, msg });
    this.balances.set(recipient, (this.balances.get(recipient) ?? 0n) + amount);
    return fakeHash(`deliver:${recipient}:${amount}:${this.n++}`);
  }
  async usdcBalance(account: string) {
    return this.balances.get(account) ?? 0n;
  }
  /** Simulate the Cascade contract paying a deposit address. */
  send(to: string, amount: bigint) {
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
  }
}

interface MockToken extends Token {
  /** price in micro-dollars, for integer math */
  priceMicro: bigint;
}

const T = (assetId: string, blockchain: string, symbol: string, decimals: number, price: number): MockToken => ({
  assetId, blockchain, symbol, decimals, price,
  priceUpdatedAt: "2026-11-03T00:00:00.000Z",
  priceMicro: BigInt(Math.round(price * 1e6)),
});

export const MOCK_TOKENS: MockToken[] = [
  T(USDC_NEAR_ASSET, "near", "USDC", 6, 1),
  T("nep141:wrap.near", "near", "wNEAR", 24, 2.5),
  T("nep141:base.omft.near", "base", "ETH", 18, 2280),
  T("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "base", "USDC", 6, 1),
  T("nep141:eth.omft.near", "eth", "ETH", 18, 2280),
  T("nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "eth", "USDC", 6, 1),
  T("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", "arb", "USDC", 6, 1),
  T("nep141:sol.omft.near", "sol", "SOL", 9, 150),
  T("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "sol", "USDC", 6, 1),
  T("nep141:btc.omft.near", "btc", "BTC", 8, 68000),
];

function fakeHash(seed: string): string {
  return bytesToHex(sha256(utf8ToBytes(seed)));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fakeAddress(chain: string, seed: string): string {
  const h = fakeHash(seed);
  if (chain === "near") return h; // 64-hex implicit account
  if (chain === "sol") return Array.from(h.slice(0, 44), (c) => B58[parseInt(c, 16) * 3 % 58]).join("");
  if (chain === "btc") return `bc1q${h.slice(0, 38)}`;
  return `0x${h.slice(0, 40)}`;
}

/** Pretend fee taken by solvers, in basis points. */
const SPREAD_BPS = 30n;
const UNAUTH_FEE_BPS = 20n;

export interface MockRecord {
  response: QuoteResponse;
  status: ExecutionStatus;
  updatedAt: string;
  details: SwapDetails;
  direction: "in" | "out";
  deadlineMs: number;
}

/**
 * Where the mock keeps its quotes. In memory by default; a serverless
 * deployment passes a database-backed one so every isolate sees the same swaps.
 */
export interface MockRecords {
  get(depositAddress: string): Promise<MockRecord | undefined>;
  set(depositAddress: string, r: MockRecord): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryMockRecords implements MockRecords {
  private readonly m = new Map<string, MockRecord>();
  async get(a: string) {
    const r = this.m.get(a);
    return r ? structuredClone(r) : undefined;
  }
  async set(a: string, r: MockRecord) {
    this.m.set(a, structuredClone(r));
  }
  async keys() {
    return [...this.m.keys()];
  }
}

export interface MockOneClickOptions {
  records?: MockRecords;
  driver?: MockDriver;
  /** Behave as if a partner JWT is configured. */
  authenticated?: boolean;
  now?: () => number;
  seed?: string;
}

export class MockOneClick implements OneClick {
  readonly driver: MockDriver;
  private readonly authenticated: boolean;
  private readonly now: () => number;
  private readonly seed: string;
  private n = 0;
  private readonly records: MockRecords;

  constructor(opts: MockOneClickOptions = {}) {
    this.driver = opts.driver ?? new MemoryDriver();
    this.authenticated = opts.authenticated ?? false;
    this.now = opts.now ?? Date.now;
    this.seed = opts.seed ?? "cascade-mock";
    this.records = opts.records ?? new MemoryMockRecords();
  }

  async tokens(): Promise<Token[]> {
    return MOCK_TOKENS.map(({ priceMicro: _p, ...t }) => t);
  }

  private token(assetId: string): MockToken {
    const t = MOCK_TOKENS.find((x) => x.assetId === assetId);
    if (!t) throw new OneClickError(400, { message: `tokenIn is not valid: ${assetId}` }, `unknown asset ${assetId}`);
    return t;
  }

  /** Convert `amount` of `from` into `to` at mock prices, rounding up (we never under-quote what the payer owes). */
  private convert(amount: bigint, from: MockToken, to: MockToken, roundUp: boolean): bigint {
    const num = amount * from.priceMicro * 10n ** BigInt(to.decimals);
    const den = to.priceMicro * 10n ** BigInt(from.decimals);
    return roundUp ? (num + den - 1n) / den : num / den;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    for (const k of ["swapType", "originAsset", "destinationAsset", "amount", "refundTo", "recipient", "deadline"] as const) {
      if (req[k] === undefined || req[k] === "") throw new OneClickError(400, { message: `${k} is required` }, `${k} is required`);
    }
    if (req.confidentiality && req.confidentiality !== "public" && !this.authenticated) {
      throw new OneClickError(401, { message: "User authentication is required for confidential intent quotes" }, "401 confidential");
    }
    if (!/^\d+$/.test(req.amount) || BigInt(req.amount) <= 0n) {
      throw new OneClickError(400, { message: "amount must be a positive integer string" }, "bad amount");
    }
    const tin = this.token(req.originAsset);
    const tout = this.token(req.destinationAsset);
    const appFeeBps = BigInt((req.appFees ?? []).reduce((t, f) => t + f.fee, 0));
    const fee = SPREAD_BPS + appFeeBps + (this.authenticated ? 0n : UNAUTH_FEE_BPS);
    const slip = BigInt(req.slippageTolerance ?? 100);
    const amount = BigInt(req.amount);

    let amountIn: bigint, minAmountIn: bigint, amountOut: bigint, minAmountOut: bigint;
    if (req.swapType === "EXACT_OUTPUT") {
      amountOut = amount;
      minAmountOut = amount;
      minAmountIn = (this.convert(amount, tout, tin, true) * (10_000n + fee) + 9_999n) / 10_000n;
      amountIn = (minAmountIn * (10_000n + slip) + 9_999n) / 10_000n;
    } else {
      amountIn = amount;
      minAmountIn = amount;
      amountOut = (this.convert(amount, tin, tout, false) * (10_000n - fee)) / 10_000n;
      minAmountOut = (amountOut * (10_000n - slip)) / 10_000n;
    }
    const fmt = (v: bigint, d: number) => (Number(v) / 10 ** d).toString();
    const usd = (v: bigint, t: MockToken) => ((Number(v) / 10 ** t.decimals) * t.price).toFixed(6);
    const deadlineMs = Date.parse(req.deadline);
    const response: QuoteResponse = {
      correlationId: fakeHash(`${this.seed}:corr:${this.n}`).slice(0, 32),
      timestamp: new Date(this.now()).toISOString(),
      signature: `ed25519:mock${fakeHash(`${this.seed}:sig:${this.n}`).slice(0, 40)}`,
      quoteRequest: {
        ...req,
        ...(this.authenticated ? {} : { appFees: [...(req.appFees ?? []), { recipient: "1click-fee.near", fee: Number(UNAUTH_FEE_BPS) }] }),
      },
      quote: {
        amountIn: amountIn.toString(),
        amountInFormatted: fmt(amountIn, tin.decimals),
        amountInUsd: usd(amountIn, tin),
        minAmountIn: minAmountIn.toString(),
        amountOut: amountOut.toString(),
        amountOutFormatted: fmt(amountOut, tout.decimals),
        amountOutUsd: usd(amountOut, tout),
        minAmountOut: minAmountOut.toString(),
        timeEstimate: tin.blockchain === "btc" ? 1800 : 30,
      },
    };
    if (!req.dry) {
      const depositAddress = fakeAddress(tin.blockchain, `${this.seed}:deposit:${this.n}`);
      response.quote.depositAddress = depositAddress;
      response.quote.deadline = req.deadline;
      response.quote.timeWhenInactive = req.deadline;
      await this.records.set(depositAddress, {
        response,
        status: "PENDING_DEPOSIT",
        updatedAt: response.timestamp,
        details: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] },
        direction: req.destinationAsset === USDC_NEAR_ASSET && tin.blockchain !== "near" ? "in" : "out",
        deadlineMs,
      });
    }
    this.n++;
    return response;
  }

  private async rec(depositAddress: string): Promise<MockRecord> {
    const r = await this.records.get(depositAddress);
    if (!r) throw new OneClickError(404, { message: "Deposit address not found" }, "404 deposit address");
    return r;
  }

  private async set(r: MockRecord, status: ExecutionStatus, details: Partial<SwapDetails> = {}) {
    r.status = status;
    r.updatedAt = new Date(this.now()).toISOString();
    r.details = { ...r.details, ...details };
    await this.records.set(r.response.quote.depositAddress!, r);
  }

  private view(r: MockRecord): StatusResponse {
    return {
      correlationId: r.response.correlationId,
      quoteResponse: r.response,
      status: r.status,
      updatedAt: r.updatedAt,
      swapDetails: r.details,
    };
  }

  async status(depositAddress: string): Promise<StatusResponse> {
    const r = await this.rec(depositAddress);
    if (r.direction === "out" && (r.status === "PENDING_DEPOSIT" || r.status === "KNOWN_DEPOSIT_TX")) {
      const got = await this.driver.usdcBalance(depositAddress);
      const q = r.response.quote;
      if (got > 0n && this.now() > r.deadlineMs) {
        const tx = await this.driver.deliverUsdc(r.response.quoteRequest.refundTo, got);
        await this.set(r, "REFUNDED", {
          depositedAmount: got.toString(), refundedAmount: got.toString(), refundReason: "DEADLINE_EXCEEDED",
          nearTxHashes: [tx],
        });
      } else if (got >= BigInt(q.minAmountIn)) {
        const dest = this.token(r.response.quoteRequest.destinationAsset).blockchain;
        const h = fakeHash(`${this.seed}:dest:${depositAddress}`);
        await this.set(r, "SUCCESS", {
          depositedAmount: got.toString(), amountIn: got.toString(), amountOut: q.amountOut,
          amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd,
          destinationChainTxHashes: [{ hash: `0x${h}`, explorerUrl: `mock://${dest}/tx/0x${h}` }],
        });
      } else if (got > 0n) {
        await this.set(r, "INCOMPLETE_DEPOSIT", { depositedAmount: got.toString() });
      }
    }
    return this.view(r);
  }

  async submitDeposit(req: SubmitDepositRequest): Promise<StatusResponse> {
    const r = await this.rec(req.depositAddress);
    if (r.status === "PENDING_DEPOSIT") {
      await this.set(r, "KNOWN_DEPOSIT_TX", { originChainTxHashes: [{ hash: req.txHash, explorerUrl: `mock://tx/${req.txHash}` }] });
    }
    return this.status(req.depositAddress);
  }

  // ----------------------------------------------------- test controls

  /**
   * Pretend the payer sent `amount` (default: the quoted amountIn) of the
   * origin asset to an incoming quote's deposit address.
   */
  async simulatePayerDeposit(depositAddress: string, opts: { amount?: bigint; fail?: boolean } = {}): Promise<StatusResponse> {
    const r = await this.rec(depositAddress);
    if (r.direction !== "in") throw new Error("simulatePayerDeposit is for incoming quotes");
    const q = r.response.quote;
    const amount = opts.amount ?? BigInt(q.amountIn);
    const originTx = { hash: `0x${fakeHash(`${this.seed}:origin:${depositAddress}`)}`, explorerUrl: "mock://origin" };
    if (this.now() > r.deadlineMs || amount < BigInt(q.minAmountIn) || opts.fail) {
      await this.set(r, "REFUNDED", {
        depositedAmount: amount.toString(), refundedAmount: amount.toString(),
        refundReason: opts.fail ? "SWAP_FAILED" : amount < BigInt(q.minAmountIn) ? "PARTIAL_DEPOSIT" : "DEADLINE_EXCEEDED",
        originChainTxHashes: [originTx],
      });
      return this.view(r);
    }
    await this.set(r, "PROCESSING", { depositedAmount: amount.toString(), originChainTxHashes: [originTx] });
    const out = BigInt(q.amountOut);
    const tx = await this.driver.deliverUsdc(r.response.quoteRequest.recipient, out, r.response.quoteRequest.customRecipientMsg);
    await this.set(r, "SUCCESS", {
      amountIn: amount.toString(), amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd,
      amountOut: out.toString(), amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd,
      nearTxHashes: [tx], destinationChainTxHashes: [{ hash: tx, explorerUrl: `mock://near/tx/${tx}` }],
    });
    return this.view(r);
  }

  /** All deposit addresses this mock has issued, oldest first. */
  depositAddresses(): Promise<string[]> {
    return this.records.keys();
  }
}
