import { ApplicationStatus, AppFramework, GitProvider } from './enums';

export interface CreateApplicationRequest {
  name: string;
  projectId: string;
  framework: AppFramework;
  gitUrl?: string;
  gitBranch?: string;
  gitProvider?: GitProvider;
  dockerImage?: string;
  dockerComposeFile?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
}

export interface ApplicationResponse {
  id: string;
  name: string;
  projectId: string;
  framework: AppFramework;
  status: ApplicationStatus;
  gitUrl: string | null;
  gitBranch: string | null;
  gitProvider: GitProvider | null;
  dockerImage: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  domainId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationLogsRequest {
  applicationId: string;
  lines?: number;
  since?: string;
}
