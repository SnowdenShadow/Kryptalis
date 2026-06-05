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
WORKDIR /app/apps/api
EXPOSE 4000
# Apply schema changes on every start (idempotent — DB unchanged if schema already matches).
CMD ["sh", "-c", "pnpm exec prisma db push --skip-generate --accept-data-loss || true; node dist/main"]
