/**
 * Server-side proxy for the merchant dashboard. Merchant API routes take the
 * secret key and send no CORS headers (browsers cannot call them directly).
 * Only these paths are forwarded; the key comes from the x-cascade-key header
 * and is never stored here.
 */
const API = process.env.CASCADE_API_URL ?? process.env.NEXT_PUBLIC_CASCADE_API ?? "http://127.0.0.1:8788";
const ALLOWED = [/^merchant(\/balance)?$/, /^checkout\/sessions(\/cs_[A-Za-z0-9]+(\/refunds)?)?$/, /^refunds\/rf_[A-Za-z0-9]+(\/confirm)?$/, /^webhooks(\/evt_[A-Za-z0-9]+\/retry)?$/, /^reports\/ledger\.csv$/];

async function forward(req: Request, path: string[]): Promise<Response> {
  const p = path.join("/");
  if (!ALLOWED.some((re) => re.test(p))) return Response.json({ error: { message: "not allowed" } }, { status: 404 });
  const key = req.headers.get("x-cascade-key") ?? "";
  if (!key.startsWith("sk_")) return Response.json({ error: { message: "missing secret key" } }, { status: 401 });
  const url = new URL(req.url);
  const r = await fetch(`${API}/v1/${p}${url.search}`, {
    method: req.method,
    headers: { authorization: `Bearer ${key}`, ...(req.method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(req.method === "POST" ? { body: await req.text() } : {}),
    cache: "no-store",
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json", ...(r.headers.get("content-disposition") ? { "content-disposition": r.headers.get("content-disposition")! } : {}) } });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
