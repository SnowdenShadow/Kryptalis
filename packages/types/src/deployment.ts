import { DeploymentStatus } from './enums';

export interface TriggerDeploymentRequest {
  applicationId: string;
  commitSha?: string;
  force?: boolean;
}

/**
 * Deployment as returned by GET /deployments (list, take 50) and
 * GET /deployments/:id. The list endpoint includes `application` ({id, name});
 * the detail endpoint additionally includes `triggeredBy` ({id, name}).
 */
export interface DeploymentResponse {
  id: string;
  applicationId: string;
  status: `${DeploymentStatus}`;
  commitSha: string | null;
  commitMessage: string | null;
  buildLogs: string | null;
  deployLogs: string | null;
  duration: number | null;
  triggeredById: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  application?: { id: string; name: string };
  triggeredBy?: { id: string; name: string };
}
