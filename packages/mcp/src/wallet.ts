/**
 * The agent wallet: an AI agent spends its owner's money only through a
 * Cascade allowance, whose limits the NEAR contract enforces (per payment,
 * per day, expiry, allowed recipients). The agent's key can call nothing
 * else that moves money, and pays no gas (the Cascade relayer does).
 */
import type { Allowance } from "@cascade/core";
import { CascadeReader, appCalls, signMeta, type Chain } from "@cascade/near";
import { X402_HEADERS, decodeHeader, fetchWithPayment, type X402Requirement, type X402Settlement } from "@cascade/sdk";
import { ToolError, dollars, fmt, num, str, type Tool } from "./protocol.js";

export interface WalletConfig {
  chain: Chain;
  app: string;
  /** Whose allowance this agent spends. */
  owner: string;
  /** The agent's NEAR account and key. */
  agent: string;
  agentKey: string;
  /** Submit a signed delegate (NEP-366); returns the transaction and its signer. Default: POST to the Cascade relayer. */
  relay: (signedDelegateB64: string) => Promise<{ hash: string; ok: boolean; error?: string | null; signer: string }>;
  fetch?: typeof fetch;
  /** Largest body returned to the model, in characters. */
  maxBody?: number;
}

/** The Cascade relayer over HTTP. */
export function httpRelay(relayerUrl: string, f: typeof fetch = fetch): WalletConfig["relay"] {
  let signer: string | null = null;
  return async (b64) => {
    signer ??= ((await (await f(`${relayerUrl}/health`)).json()) as { account: string }).account;
    const r = await f(`${relayerUrl}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedDelegate: b64 }) });
    const j = (await r.json()) as { hash?: string; ok?: boolean; error?: string | null };
    if (!r.ok) throw new ToolError(`relayer refused the payment: ${j.error ?? r.status}`);
    return { hash: j.hash ?? "", ok: !!j.ok, error: j.error ?? null, signer: signer! };
  };
}

export class AgentWallet {
  readonly reader: CascadeReader;
  constructor(readonly cfg: WalletConfig) {
    this.reader = new CascadeReader(cfg.chain, cfg.app);
  }

  async allowance(): Promise<Allowance> {
    const a = await this.reader.allowance(this.cfg.owner, this.cfg.agent);
    if (!a) throw new ToolError(`${this.cfg.owner} has not given ${this.cfg.agent} a budget yet (set_allowance)`);
    return a;
  }

  async status() {
    const a = await this.allowance();
    const today = Math.floor(Date.now() / 86_400_000) === a.day ? BigInt(a.spent_today) : 0n;
    return {
      agent: a.agent, owner: a.owner, purpose: a.purpose,
      active: !a.revoked && Date.now() < a.policy.expires_at_ms,
      balance: fmt(a.balance),
      perPaymentLimit: fmt(a.policy.per_payment_max),
      dailyLimit: fmt(a.policy.daily_max),
      leftToday: fmt(BigInt(a.policy.daily_max) - today),
      expires: new Date(a.policy.expires_at_ms).toISOString(),
      allowedRecipients: a.policy.payees.length ? a.policy.payees : "any",
      spentSoFar: fmt(a.total_spent),
      payments: a.payments,
      authorizedAt: new Date(a.authorized_at_ms).toISOString(),
    };
  }

  /** Pay one x402 requirement from the allowance. The contract re-checks every limit. */
  private async pay(req: X402Requirement, maxUnits: bigint) {
    if (req.extra.method !== "agent_pay") throw new ToolError("this API does not accept payment from a Cascade budget");
    if (req.extra.contract !== this.cfg.app) throw new ToolError(`this API expects a different Cascade contract (${req.extra.contract})`);
    const amount = BigInt(req.amount);
    if (amount > maxUnits) throw new ToolError(`the API asks $${fmt(amount)}, above the $${fmt(maxUnits)} you allowed for this call`);
    const account = this.cfg.chain.account(this.cfg.agent, this.cfg.agentKey as never);
    const signed = await signMeta(account, appCalls(this.cfg.app).agentPay(this.cfg.owner, req.payTo, amount, req.extra.memo ?? ""));
    const r = await this.cfg.relay(signed);
    if (!r.ok) throw new ToolError(`the contract refused the payment: ${r.error ?? "unknown"}`);
    return { txHash: r.hash, sender: r.signer };
  }

  /** GET/POST a URL; if it answers 402 (x402), pay from the budget and retry. */
  async paidFetch(p: { url: string; method?: string; body?: string; maxUsd?: bigint }) {
    if (!/^https?:\/\//.test(p.url)) throw new ToolError("url must be http(s)");
    const a = await this.allowance();
    const cap = p.maxUsd ?? BigInt(a.policy.per_payment_max);
    let paid: { amount: string; payTo: string; tx: string } | null = null;
    const res = await fetchWithPayment(
      p.url,
      { method: p.method ?? "GET", ...(p.body !== undefined ? { body: p.body, headers: { "content-type": "application/json" } } : {}) },
      {
        ...(this.cfg.fetch ? { fetch: this.cfg.fetch } : {}),
        timeoutMs: 120_000,
        pollMs: 1500,
        choose: (accepts) => {
          const mine = accepts.find((x) => x.extra.method === "agent_pay");
          if (!mine) throw new ToolError(`this API takes ${accepts.map((x) => `${x.extra.symbol} on ${x.extra.chain}`).join(", ")}, not a Cascade budget`);
          return mine;
        },
        pay: async (req) => {
          const r = await this.pay(req, cap);
          paid = { amount: fmt(req.amount), payTo: req.payTo, tx: r.txHash };
          return r;
        },
      },
    );
    const s = res.headers.get(X402_HEADERS.response);
    const settlement = s ? decodeHeader<X402Settlement>(s) : null;
    const text = await res.text();
    const max = this.cfg.maxBody ?? 20_000;
    return {
      status: res.status,
      paid,
      settlement,
      contentType: res.headers.get("content-type"),
      body: text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text,
    };
  }

  tools(): Tool[] {
    return [
      {
        name: "wallet_status",
        title: "Budget status",
        description: "Show this agent's spending budget: balance, per-payment and daily limits, what is left today, expiry, allowed recipients, and the purpose its owner gave.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        readOnly: true,
        run: () => this.status(),
      },
      {
        name: "paid_fetch",
        title: "Fetch a paid API",
        description:
          "Request a URL. If it requires payment (HTTP 402, x402), pay from the owner's budget on NEAR and return the response. " +
          "Payments are capped by the owner's on-chain limits and by max_usd for this call. Returns the status, what was paid, and the body.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "http(s) URL" },
            method: { type: "string", enum: ["GET", "POST"], default: "GET" },
            body: { type: "string", description: "Request body for POST (JSON)" },
            max_usd: { type: "number", description: "Most you will pay for this call, in dollars (default: the per-payment limit)" },
          },
          required: ["url"],
          additionalProperties: false,
        },
        run: async (a) => {
          const max = num(a, "max_usd");
          return this.paidFetch({
            url: str(a, "url")!,
            ...(str(a, "method", false) ? { method: str(a, "method", false)! } : {}),
            ...(str(a, "body", false) !== undefined ? { body: str(a, "body", false)! } : {}),
            ...(max !== undefined ? { maxUsd: dollars(max, "max_usd") } : {}),
          });
        },
      },
    ];
  }
}
