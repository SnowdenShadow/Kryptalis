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
COPY . .
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
# Reconcile the DB schema on every start.
#
# `prisma db push` syncs schema.prisma directly to the database — fast,
# idempotent, doesn't care whether the DB is empty or already has data.
# Pre-1.0 we treat schema.prisma as the single source of truth and skip
# the migration file workflow entirely; there's no value in keeping a
# linear migration history while the schema is still moving daily and
# every existing install gets refreshed via the auto-update timer.
# `--accept-data-loss` is required for column drops; pick destructive
# ops manually and pre-truncate when needed.
#
# Once we cut 1.0 we'll start minting versioned migrations for every
# schema change and switch this back to `migrate deploy`.
CMD ["sh", "-c", "pnpm exec prisma db push --skip-generate --accept-data-loss && node dist/main"]
