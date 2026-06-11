#!/bin/sh
# Container entrypoint: run versioned migrations, then start the API.
#
# `migrate deploy` only runs migrations not yet recorded in
# _prisma_migrations — fast and idempotent, and destructive changes are
# explicit SQL in a reviewed migration file instead of an implicit diff.
#
# Existing installs were provisioned with `db push` (no migrations
# table): their first `migrate deploy` fails with P3005 ("database
# schema is not empty"). ONLY in that case do we baseline by marking
# 0_init as applied (the tables already exist) and deploy the rest.
#
# Any other failure (network blip, OOM, a 0_init that died half-way on
# a FRESH database…) must NOT be baselined: blindly resolving 0_init
# there would stamp a partially-applied migration as done and leave the
# schema silently inconsistent. We surface the original output and exit
# non-zero so the container restart loop retries from a clean state.
set -eu

deploy_out=$(pnpm exec prisma migrate deploy 2>&1) && deploy_status=0 || deploy_status=$?
printf '%s\n' "$deploy_out"

if [ "$deploy_status" -ne 0 ]; then
  if printf '%s' "$deploy_out" | grep -q 'P3005'; then
    echo 'P3005 detected (schema not empty, no migrations table) — baselining 0_init.'
    pnpm exec prisma migrate resolve --applied 0_init
    pnpm exec prisma migrate deploy
  else
    echo 'prisma migrate deploy failed without P3005 — refusing to baseline; see output above.' >&2
    exit "$deploy_status"
  fi
fi

exec node dist/main
