import { API } from "../../lib/api";

/** Merchant API call with the secret key (same origin as the API; the key lives in this tab only). */
export async function call<T>(key: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

