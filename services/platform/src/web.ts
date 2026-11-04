/**
 * Serving the web app's static build (apps/web `next build`, output: export).
 * Checkout and receipt pages are one static shell each (/c/_ and /r/_) that
 * read the id from the URL in the browser, so any /c/<id> serves /c/_.
 */
const SHELLS: [RegExp, string][] = [
  [/^\/c\/[A-Za-z0-9_-]+\/?$/, "/c/_"],
  [/^\/r\/[A-Za-z0-9_-]+\/?$/, "/r/_"],
];

/** The asset path to serve for a page URL. */
export function webAssetPath(pathname: string): string {
  for (const [re, shell] of SHELLS) if (re.test(pathname)) return shell;
  return pathname;
}

/** Security headers. Only the checkout may be framed (the Pay button opens it in an iframe). */
export function webHeaders(pathname: string): Record<string, string> {
  return {
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    ...(pathname.startsWith("/c/") ? {} : { "x-frame-options": "DENY" }),
    ...(pathname.startsWith("/_next/static/") ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
  };
}
