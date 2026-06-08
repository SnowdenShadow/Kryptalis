-- Extend DbType with the in-memory KV alternatives (KeyDB, Dragonfly)
-- and the columnar analytics store (ClickHouse). Compose templates +
-- connection strings for these live in databases.service.ts.
ALTER TYPE "DbType" ADD VALUE IF NOT EXISTS 'KEYDB';
ALTER TYPE "DbType" ADD VALUE IF NOT EXISTS 'DRAGONFLY';
ALTER TYPE "DbType" ADD VALUE IF NOT EXISTS 'CLICKHOUSE';
