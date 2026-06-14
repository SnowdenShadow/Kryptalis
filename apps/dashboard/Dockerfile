FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
# Next inlines NEXT_PUBLIC_* into the static bundle at build time.
# Passed by compose via `build.args` (default localhost for dev).
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
# Scoped copies (not `COPY . .`): an api-only change must not invalidate
# the dashboard build cache, and vice versa.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard
RUN pnpm --filter @dockcontrol/types build
RUN pnpm --filter @dockcontrol/dashboard build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Next.js standalone output already bundles the minimal node_modules it needs.
# outputFileTracingRoot is set to the monorepo root, so the standalone tree
# contains both apps/dashboard/server.js AND the workspace node_modules.
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public
# Unlike the api container (which drives the host Docker daemon), the
# dashboard has zero reason to run as root.
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
