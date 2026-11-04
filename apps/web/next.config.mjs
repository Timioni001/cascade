/**
 * The web app is a static export (`next build` writes ./out), served by the
 * same deployment as the API: the Cloudflare Worker's assets, or the Node
 * server. Pages call the API on their own origin. In `next dev`, API paths
 * are proxied to the local backend (CASCADE_DEV_API, default :8788).
 * Security headers come from the host (services/platform/src/web.ts and public/_headers).
 */
const dev = process.env.NODE_ENV !== "production";
const devApi = process.env.CASCADE_DEV_API ?? "http://127.0.0.1:8788";

/** @type {import('next').NextConfig} */
export default {
  ...(dev ? {} : { output: "export" }),
  images: { unoptimized: true },
  transpilePackages: ["@cascade/sdk"],
  // Workspace packages use ESM-style "./x.js" imports of TypeScript files.
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  ...(dev
    ? {
        async rewrites() {
          return ["v1", "relayer", "api", "health"].flatMap((p) => [
            { source: `/${p}`, destination: `${devApi}/${p}` },
            { source: `/${p}/:path*`, destination: `${devApi}/${p}/:path*` },
          ]).concat([
            { source: "/c/:id", destination: "/c/_" },
            { source: "/r/:id", destination: "/r/_" },
            { source: "/i/:id", destination: "/i/_" },
          ]);
        },
      }
    : {}),
};
