import { DeploymentStatus } from './enums';

export interface TriggerDeploymentRequest {
  applicationId: string;
  commitSha?: string;
  force?: boolean;
}

export interface DeploymentResponse {
  id: string;
  applicationId: string;
  status: DeploymentStatus;
  commitSha: string | null;
  commitMessage: string | null;
  buildLogs: string | null;
  deployLogs: string | null;
  duration: number | null;
  triggeredBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface DeploymentListResponse {
  deployments: DeploymentResponse[];
  total: number;
  page: number;
  limit: number;
}
