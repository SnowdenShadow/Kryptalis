#!/bin/sh
# Cross-compile kryptalis-agent for Linux amd64 + arm64.
# Run this on any box with Go ≥ 1.21 installed. Binaries are dropped in apps/agent/bin/
# and served by the API at GET /api/agent/binary?arch=...

set -eu

cd "$(dirname "$0")"

mkdir -p bin

VERSION="${VERSION:-0.1.0}"
# monitor.Version is what the heartbeat reports to the API — stamping it
# here is the single source of truth for the agent version.
LDFLAGS="-s -w -X github.com/kryptalis/agent/internal/monitor.Version=$VERSION"

echo "▶ Building kryptalis-agent v$VERSION"

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags "$LDFLAGS" -o bin/kryptalis-agent-linux-amd64 ./cmd/agent
echo "  ✓ linux/amd64 → bin/kryptalis-agent-linux-amd64 ($(du -h bin/kryptalis-agent-linux-amd64 | cut -f1))"

CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags "$LDFLAGS" -o bin/kryptalis-agent-linux-arm64 ./cmd/agent
echo "  ✓ linux/arm64 → bin/kryptalis-agent-linux-arm64 ($(du -h bin/kryptalis-agent-linux-arm64 | cut -f1))"

echo "Done."
