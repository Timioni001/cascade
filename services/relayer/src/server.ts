import { Hono } from "hono";
import { cors } from "hono/cors";
import { RelayError, type Relayer } from "./relayer.js";

/** HTTP surface: POST /relay, POST /names, GET /health. */
export function relayerApp(relayer: Relayer, opts: { trustProxy?: boolean; ipHeader?: string; allowOrigins?: string[] } = {}) {
  const app = new Hono();
  // The web app calls the relayer from the browser (sign-up, fee-free actions).
  if (opts.allowOrigins?.length) app.use("*", cors({ origin: opts.allowOrigins, allowMethods: ["GET", "POST"], allowHeaders: ["content-type"] }));
  const ipOf = (c: { req: { header: (k: string) => string | undefined } }) =>
    (opts.ipHeader ? c.req.header(opts.ipHeader) : undefined) ?? (opts.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? c.req.header("x-real-ip") ?? "local";

  app.onError((err, c) => {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/relay", async (c) => {
    const body = await c.req.json<{ signedDelegate?: string }>().catch(() => ({}) as { signedDelegate?: string });
    if (!body.signedDelegate) throw new RelayError(400, "signedDelegate (base64) is required");
    const r = await relayer.relay(body.signedDelegate, { ip: ipOf(c) });
    return c.json({ hash: r.hash, ok: r.ok, value: r.value ?? null, events: r.events, error: r.error ?? null });
  });

  app.post("/names", async (c) => {
    const body = await c.req.json<{ name?: string; publicKey?: string; appKey?: string; humanToken?: string }>().catch(() => ({}) as Record<string, string>);
    if (!body.name || !body.publicKey) throw new RelayError(400, "name and publicKey are required");
    const r = await relayer.createName({ name: body.name, publicKey: body.publicKey, ...(body.appKey ? { appKey: body.appKey } : {}) }, { ip: ipOf(c), ...(body.humanToken ? { humanToken: body.humanToken } : {}) });
    return c.json({ accountId: r.accountId, hash: r.hash });
  });

  return app;
}
