import { BackupStatus, BackupTarget } from './enums';

export interface CreateBackupRequest {
  name: string;
  serverId: string;
  target: BackupTarget;
  includeApplications?: boolean;
  includeDatabases?: boolean;
  includeVolumes?: boolean;
  schedule?: string;
}

export interface BackupResponse {
  id: string;
  name: string;
  serverId: string;
  target: BackupTarget;
  status: BackupStatus;
  size: number | null;
  schedule: string | null;
  lastRunAt: string | null;
  createdAt: string;
}
