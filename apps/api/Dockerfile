FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Cross-compile the kryptalis-agent for both archs the API serves at
# GET /api/agent/binary?arch=amd64|arm64 — agent.controller.ts resolves
# /app/apps/agent/bin/kryptalis-agent-linux-<arch> inside the container.
FROM golang:1.25-alpine AS agent-builder
WORKDIR /src
COPY apps/agent/go.mod apps/agent/go.sum ./
RUN go mod download
COPY apps/agent/ ./
ARG AGENT_VERSION=0.1.0
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -trimpath -ldflags "-s -w -X github.com/kryptalis/agent/internal/monitor.Version=${AGENT_VERSION}" \
      -o /out/kryptalis-agent-linux-amd64 ./cmd/agent \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
      go build -trimpath -ldflags "-s -w -X github.com/kryptalis/agent/internal/monitor.Version=${AGENT_VERSION}" \
      -o /out/kryptalis-agent-linux-arm64 ./cmd/agent

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
# Agent binaries served by GET /api/agent/binary?arch=... — the controller
# probes /app/apps/agent/bin/kryptalis-agent-linux-<arch>.
COPY --from=agent-builder /out/ ./apps/agent/bin/
# Startup script: migrate deploy, P3005-gated baseline fallback, then
# node dist/main. A dedicated COPY'd script (instead of an inline sh -c
# one-liner) so the P3005 detection logic is readable and reviewable —
# the unconditional fallback used to baseline 0_init after ANY deploy
# failure, which could silently stamp a half-applied 0_init on a fresh
# DB. Full rationale in docker-start.sh.
COPY apps/api/docker-start.sh /usr/local/bin/docker-start.sh
RUN chmod +x /usr/local/bin/docker-start.sh
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["docker-start.sh"]
