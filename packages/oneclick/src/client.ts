import type { QuoteRequest, QuoteResponse, StatusResponse, SubmitDepositRequest, Token } from "./types.js";

/** Everything Cascade needs from 1Click. Implemented by HttpOneClick and MockOneClick. */
export interface OneClick {
  tokens(): Promise<Token[]>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse>;
  submitDeposit(req: SubmitDepositRequest): Promise<StatusResponse>;
}

export class OneClickError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "OneClickError";
  }
}

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

export interface HttpOneClickOptions {
  baseUrl?: string;
  /** Partner JWT from partners.near-intents.org. Server-side only. Without it 1Click adds a 0.2% fee and refuses confidential quotes. */
  jwt?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpOneClick implements OneClick {
  private readonly base: string;
  private readonly jwt: string | undefined;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpOneClickOptions = {}) {
    this.base = (opts.baseUrl ?? ONECLICK_BASE_URL).replace(/\/$/, "");
    this.jwt = opts.jwt;
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  get authenticated(): boolean {
    return Boolean(this.jwt);
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg = (json as { message?: string } | undefined)?.message ?? res.statusText;
      throw new OneClickError(res.status, json, `1Click ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return json as T;
  }

  tokens() {
    return this.req<Token[]>("GET", "/v0/tokens");
  }
  quote(req: QuoteRequest) {
    return this.req<QuoteResponse>("POST", "/v0/quote", req);
  }
  status(depositAddress: string, depositMemo?: string) {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set("depositMemo", depositMemo);
    return this.req<StatusResponse>("GET", `/v0/status?${q}`);
  }
  submitDeposit(req: SubmitDepositRequest) {
    return this.req<StatusResponse>("POST", "/v0/deposit/submit", req);
  }
}
