# Cascade on any container host: the platform (checkout API, relayer, demo
# shop), the settler loop and the web app in one process (pnpm backend).
# On Cloudflare use services/worker instead. See docs/hosting.md.

# --- web app: static export
FROM node:22.20-slim AS web
ARG NEXT_PUBLIC_NEAR_NETWORK=testnet
ARG NEXT_PUBLIC_SANDBOX=
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @cascade/web... \
 && NEXT_PUBLIC_NEAR_NETWORK=$NEXT_PUBLIC_NEAR_NETWORK NEXT_PUBLIC_SANDBOX=$NEXT_PUBLIC_SANDBOX pnpm --filter @cascade/web build

# --- server
FROM node:22.20-slim
ENV PNPM_HOME=/pnpm \
    NODE_OPTIONS=--no-warnings=ExperimentalWarning \
    CASCADE_DB=/data/cascade.sqlite \
    PORT=8788
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY deployments ./deployments
# Installs tsx too (a dev dependency of the root): the server runs TypeScript directly.
RUN pnpm install --frozen-lockfile --filter @cascade/server... --filter cascade \
 && mkdir -p /data && chown -R node:node /data
COPY --from=web /app/apps/web/out ./apps/web/out
ENV NODE_ENV=production

USER node
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Run tsx directly (not through pnpm) so SIGTERM reaches the server.
CMD ["node_modules/.bin/tsx", "services/server/src/main.ts"]
