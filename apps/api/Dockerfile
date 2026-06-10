FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
# Scoped copies (not `COPY . .`): a dashboard-only change must not
# invalidate the api build cache, and vice versa.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @kryptalis/types build
# Generate the Prisma client BEFORE tsc — otherwise TaskType, Role, ProjectRole, etc.
# aren't exported from @prisma/client and the API build fails with TS2305.
RUN cd apps/api && pnpm exec prisma generate
RUN pnpm --filter @kryptalis/api build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# The API talks to the host Docker daemon (compose stacks, mail server, Caddy reload,
# port checks, etc.) — it MUST have the docker CLI + compose plugin + git for deploys.
RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client ca-certificates
# Copy the whole workspace so pnpm symlinks resolve (.pnpm store lives at the root).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
# Marketplace catalog is JSON (data, not code) so nest's tsc doesn't
# emit it into dist/. Copy it next to the compiled service so the
# resolver finds it via path.join(__dirname, 'catalog.json').
COPY --from=builder /app/apps/api/src/modules/marketplace/catalog.json ./apps/api/dist/modules/marketplace/catalog.json
WORKDIR /app/apps/api
EXPOSE 4000
# Apply versioned migrations on every start.
#
# `migrate deploy` only runs migrations not yet recorded in
# _prisma_migrations — fast and idempotent, and destructive changes are
# explicit SQL in a reviewed migration file instead of an implicit diff.
#
# Existing installs were provisioned with `db push` (no migrations
# table): the first `migrate deploy` fails with P3005 ("schema not
# empty"). The fallback baselines them by marking 0_init as applied
# (the tables already exist), then deploys the rest. Fresh installs run
# 0_init normally.
CMD ["sh", "-c", "(pnpm exec prisma migrate deploy || (pnpm exec prisma migrate resolve --applied 0_init && pnpm exec prisma migrate deploy)) && node dist/main"]
