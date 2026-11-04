/** Browser-side calls to the public Cascade API: same origin by default (one deployment serves the site and the API). */
export const API = (process.env.NEXT_PUBLIC_CASCADE_API ?? "").replace(/\/$/, "");
export const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "sandbox";

export async function publicApi<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/v1/public${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

/** Explorer link for a NEAR transaction, or null in the local sandbox. */
export function nearTxUrl(hash: string | null | undefined): string | null {
  if (!hash || NETWORK === "sandbox") return null;
  return NETWORK === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}

/** The last path segment of the current URL: the id in /c/<id> and /r/<id> (the pages are static shells). */
export function routeId(): string {
  if (typeof window === "undefined") return "";
  return decodeURIComponent(window.location.pathname.replace(/\/$/, "").split("/").pop() ?? "");
}
