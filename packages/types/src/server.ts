import { ServerStatus } from './enums';

export interface CreateServerRequest {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  password?: string;
}

export interface AgentTokenResponse {
  id: string;
  token: string;
  serverId?: string;
  expiresAt?: string | null;
  createdAt?: string;
}

/**
 * Server as returned by GET /servers (full Prisma row).
 * BigInt columns (totalMemory, totalDisk) are serialized as decimal strings
 * by the API (see BigInt.prototype.toJSON in apps/api/src/main.ts) — wrap
 * them in Number() with a guard before doing arithmetic.
 */
export interface ServerResponse {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  status: `${ServerStatus}`;
  os: string | null;
  arch: string | null;
  totalMemory: string | null;
  totalDisk: string | null;
  cpuCores: number | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Included by GET /servers/local only. */
  agentTokens?: AgentTokenResponse[];
}

export interface ServerMetrics {
  serverId: string;
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  networkIn: number;
  networkOut: number;
  timestamp: string;
}
