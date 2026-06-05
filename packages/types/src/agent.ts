import { TaskType, TaskStatus } from './enums';

export interface AgentTask {
  id: string;
  serverId: string;
  type: TaskType;
  status: TaskStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentPollResponse {
  tasks: AgentTask[];
}

export interface AgentTaskResultRequest {
  taskId: string;
  status: TaskStatus;
  result?: Record<string, unknown>;
  error?: string;
}

export interface AgentHeartbeat {
  serverId: string;
  agentVersion: string;
  os: string;
  arch: string;
  uptime: number;
  metrics: {
    cpuPercent: number;
    memoryUsed: number;
    memoryTotal: number;
    diskUsed: number;
    diskTotal: number;
  };
}

export interface ApiResponse<T = unknown> {
  data: T;
  message?: string;
}

export interface PaginatedResponse<T = unknown> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
