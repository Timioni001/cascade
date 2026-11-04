import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Context } from "hono";
import { webAssetPath, webHeaders } from "@cascade/platform";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain",
};

async function isFile(p: string) {
  return stat(p).then((s) => s.isFile(), () => false);
}

/** Serves the web app's static export from `root` (the same rules as the Worker's assets). */
export function staticSite(root: string) {
  return async (c: Context) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.notFound();
    const url = new URL(c.req.url);
    const rel = normalize(decodeURIComponent(webAssetPath(url.pathname))).replace(/^(\.\.[/\\])+/, "");
    const base = join(root, rel);
    if (!base.startsWith(root)) return c.notFound();
    for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
      if (await isFile(candidate)) {
        return new Response(await readFile(candidate), {
          headers: { "content-type": TYPES[extname(candidate)] ?? "application/octet-stream", ...webHeaders(url.pathname) },
        });
      }
    }
    const nf = join(root, "404.html");
    return new Response((await isFile(nf)) ? await readFile(nf) : "not found", { status: 404, headers: { "content-type": TYPES[".html"]!, ...webHeaders(url.pathname) } });
  };
}
