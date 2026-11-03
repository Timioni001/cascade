/**
 * Webhook signatures, Stripe-style:
 *   Cascade-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 * The timestamp is signed, so a captured request cannot be replayed after
 * `toleranceSeconds`. WebCrypto only: works in Node 20+, Deno, Bun, workers, browsers.
 */
import type { WebhookEvent } from "./types.js";

export const SIGNATURE_HEADER = "Cascade-Signature";

const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhook(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

/**
 * Verify a webhook and return the parsed event. Pass the raw request body
 * exactly as received (do not re-serialize parsed JSON).
 */
export async function verifyWebhook(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<WebhookEvent> {
  if (!header) throw new WebhookVerificationError(`missing ${SIGNATURE_HEADER} header`);
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1) throw new WebhookVerificationError("malformed signature header");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) throw new WebhookVerificationError("timestamp outside tolerance");
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  if (!timingSafeEqual(expected, v1)) throw new WebhookVerificationError("signature mismatch");
  return JSON.parse(rawBody) as WebhookEvent;
}
