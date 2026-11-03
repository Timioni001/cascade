/**
 * x402 v2 (HTTP 402 payments for agents), with Cascade as the facilitator.
 * Spec: github.com/coinbase/x402 specs/x402-specification-v2.md and transports-v2/http.md.
 *
 * Server: `x402Guard(cascade, { price, description })` protects a route. Without
 * payment it answers 402 with a PAYMENT-REQUIRED header listing ways to pay:
 * one per asset/chain, each with a one-time NEAR Intents deposit address as
 * `payTo` (scheme "exact", like the Ping facilitator). The merchant receives
 * exact USDC on NEAR whatever the agent paid with.
 *
 * Client: `fetchWithPayment(url, init, { pay })` handles the 402, calls your
 * `pay(requirement)` (send the funds, return the tx hash), then retries with
 * a PAYMENT-SIGNATURE header until the payment settles.
 */
import type { Cascade } from "./server.js";

export const X402_VERSION = 2;
export const X402_HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
  /** Cascade extension: where 1Click should refund this agent if the swap fails. */
  refundTo: "X-Cascade-Refund-To",
} as const;

export interface X402Requirement {
  scheme: "exact";
  network: string; // CAIP-2, e.g. eip155:8453
  amount: string; // base units of `asset`
  asset: string; // token contract, or "native"
  payTo: string; // one-time deposit address
  maxTimeoutSeconds: number;
  extra: {
    provider: "cascade";
    sessionId: string;
    chain: string; // 1Click chain id
    symbol: string;
    decimals: number;
    amountUsd: string;
    memo?: string;
  };
}

export interface X402PaymentRequired {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType?: string };
  accepts: X402Requirement[];
}

export interface X402PaymentPayload {
  x402Version: 2;
  resource: X402PaymentRequired["resource"];
  accepted: X402Requirement;
  payload: { txHash: string };
}

export interface X402Settlement {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

/** CAIP-2 ids for the chains Cascade offers agents. */
export const CAIP2: Record<string, string> = {
  eth: "eip155:1",
  base: "eip155:8453",
  arb: "eip155:42161",
  op: "eip155:10",
  pol: "eip155:137",
  bsc: "eip155:56",
  sol: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  btc: "bip122:000000000019d6689c085ae165831e93",
  near: "near:mainnet",
};

export function encodeHeader(v: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeHeader<T>(h: string): T {
  const bin = atob(h.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as T;
}

// ------------------------------------------------------------ server

export interface GuardOptions {
  /** Dollars, e.g. "0.10". */
  price: string;
  description: string;
  mimeType?: string;
  /** 1Click asset ids to offer (max 3). Defaults to USDC on Base. */
  assets?: string[];
}

export type GuardResult =
  | { paid: true; settlement: X402Settlement; headers: Record<string, string> }
  | { paid: false; response: Response };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * Protect a fetch-style handler:
 *   const guard = x402Guard(cascade, { price: "0.10", description: "One forecast" });
 *   export async function GET(req) { const g = await guard(req); if (!g.paid) return g.response; ... }
 */
export function x402Guard(cascade: Cascade, opts: GuardOptions) {
  return async (req: Request): Promise<GuardResult> => {
    const url = new URL(req.url);
    const resource = `${req.method} ${url.origin}${url.pathname}`;
    const sig = req.headers.get(X402_HEADERS.signature);
    if (!sig) {
      const refundTo = req.headers.get(X402_HEADERS.refundTo) ?? undefined;
      const required = await cascade.x402.prepare({
        price: opts.price, description: opts.description, resource, url: url.toString(),
        ...(opts.mimeType ? { mimeType: opts.mimeType } : {}), ...(opts.assets ? { assets: opts.assets } : {}), ...(refundTo ? { refundTo } : {}),
      });
      return { paid: false, response: json(402, required, { [X402_HEADERS.required]: encodeHeader(required) }) };
    }
    let payload: X402PaymentPayload;
    try {
      payload = decodeHeader<X402PaymentPayload>(sig);
    } catch {
      return { paid: false, response: json(400, { error: "malformed PAYMENT-SIGNATURE" }) };
    }
    const settlement = await cascade.x402.settle({ payload, resource });
    const headers = { [X402_HEADERS.response]: encodeHeader(settlement) };
    if (settlement.success) return { paid: true, settlement, headers };
    const pending = settlement.errorReason === "payment_pending";
    return { paid: false, response: json(402, { error: settlement.errorReason }, { ...headers, ...(pending ? { "retry-after": "3" } : {}) }) };
  };
}

// ------------------------------------------------------------ client

export interface PayOptions {
  /** Send the funds for `req` and return the transaction hash. */
  pay: (req: X402Requirement, required: X402PaymentRequired) => Promise<string>;
  /** Pick which requirement to pay (default: the first). */
  choose?: (accepts: X402Requirement[]) => X402Requirement;
  /** Your refund address on the chain you pay from (recommended). */
  refundTo?: string;
  timeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}

export class X402Error extends Error {
  override name = "X402Error";
}

/** fetch() that pays 402 responses through Cascade and retries until the payment settles. */
export async function fetchWithPayment(input: string, init: RequestInit = {}, o: PayOptions): Promise<Response> {
  const f = o.fetch ?? fetch;
  const withHeaders = (h: Record<string, string>) => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...h } });
  const first = await f(input, withHeaders(o.refundTo ? { [X402_HEADERS.refundTo]: o.refundTo } : {}));
  if (first.status !== 402) return first;
  const h = first.headers.get(X402_HEADERS.required);
  if (!h) throw new X402Error("402 without a PAYMENT-REQUIRED header");
  const required = decodeHeader<X402PaymentRequired>(h);
  if (required.x402Version !== X402_VERSION || !required.accepts.length) throw new X402Error("unsupported payment requirements");
  const req = o.choose ? o.choose(required.accepts) : required.accepts[0]!;
  const txHash = await o.pay(req, required);
  const sig = encodeHeader({ x402Version: 2, resource: required.resource, accepted: req, payload: { txHash } } satisfies X402PaymentPayload);
  const until = Date.now() + (o.timeoutMs ?? 180_000);
  for (;;) {
    const r = await f(input, withHeaders({ [X402_HEADERS.signature]: sig }));
    if (r.status !== 402) return r;
    const s = r.headers.get(X402_HEADERS.response);
    const settlement = s ? decodeHeader<X402Settlement>(s) : null;
    if (settlement?.errorReason !== "payment_pending") throw new X402Error(`payment refused: ${settlement?.errorReason ?? "unknown"}`);
    if (Date.now() > until) throw new X402Error("payment did not settle in time");
    await new Promise((res) => setTimeout(res, o.pollMs ?? 3000));
  }
}
