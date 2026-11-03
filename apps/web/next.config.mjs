/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@cascade/sdk"],
  // Workspace packages use ESM-style "./x.js" imports of TypeScript files.
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  async headers() {
    return [
      {
        // The checkout page may be framed (the Pay button opens it in an iframe);
        // everything else may not.
        source: "/((?!c/).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};
