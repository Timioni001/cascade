/**
 * Server-side client. Uses your secret key (sk_...): never ship it to a browser.
 *
 *   const cascade = new Cascade({ apiKey: process.env.CASCADE_SECRET_KEY! });
 *   const session = await cascade.checkout.create({ amount: "25.00", description: "Poster", reference: order.id });
 *   redirect(session.url);
 */
import type { CheckoutSession, CreateSessionParams } from "./types.js";

export const DEFAULT_API_URL = "https://api.cascade.link";

export class CascadeApiError extends Error {
  override name = "CascadeApiError";
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface CascadeOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** "12.5" -> "12500000"; bigint passes through. */
export function toUnits(amount: string | bigint): string {
  if (typeof amount === "bigint") return amount.toString();
  const s = amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid amount: ${amount}`);
  const [w, f = ""] = s.split(".") as [string, string?];
  return (BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

export class Cascade {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: CascadeOptions) {
    if (!opts.apiKey?.startsWith("sk_")) throw new Error("Cascade: apiKey must be a secret key (sk_...)");
    this.base = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const r = await this.f(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!r.ok) throw new CascadeApiError(r.status, j.error?.message ?? r.statusText, j);
    return j as T;
  }

  readonly checkout = {
    /** Pass `idempotencyKey` (e.g. your order id) so a retried request cannot create two sessions. */
    create: (p: CreateSessionParams, opts: { idempotencyKey?: string } = {}) =>
      this.req<CheckoutSession>("POST", "/v1/checkout/sessions", { ...p, amount: toUnits(p.amount) }, opts.idempotencyKey),
    retrieve: (id: string) => this.req<CheckoutSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`),
    list: (opts: { limit?: number } = {}) => this.req<{ data: CheckoutSession[] }>("GET", `/v1/checkout/sessions?limit=${opts.limit ?? 20}`),
  };

  readonly merchant = {
    me: () => this.req<{ id: string; name: string; account: string; webhookUrl: string | null }>("GET", "/v1/merchant"),
    update: (p: { name?: string; webhookUrl?: string | null }) => this.req("POST", "/v1/merchant", p),
  };
}
