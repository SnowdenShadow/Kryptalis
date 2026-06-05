import { ServerStatus } from './enums';

export interface CreateServerRequest {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  password?: string;
}

export interface ServerResponse {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  status: ServerStatus;
  os: string | null;
  arch: string | null;
  totalMemory: number | null;
  totalDisk: number | null;
  cpuCores: number | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
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
