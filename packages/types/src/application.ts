import { ApplicationStatus, AppFramework, GitProvider } from './enums';
import { DomainSummary } from './domain';

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

/** One `<domain, port>` binding (apps co-hosted on a shared hostname). */
export interface ApplicationPortBinding {
  id: string;
  port: number;
  domain: DomainSummary;
}

/**
 * Application as returned by GET /applications and GET /applications/:id.
 * Mirrors the Prisma `Application` row plus the relations the service
 * includes (project, domains, portBindings) and the displayName mapping:
 * the API exposes `displayName ?? name` as `name` and stashes the canonical
 * slug-driving name in `slugName`.
 */
export interface ApplicationResponse {
  id: string;
  /** Display name (displayName when set, canonical name otherwise). */
  name: string;
  /** Canonical name — drives slugify(), container name, on-disk dir. */
  slugName?: string;
  displayName?: string | null;
  projectId: string;
  framework: `${AppFramework}`;
  status: `${ApplicationStatus}`;
  gitUrl: string | null;
  gitBranch: string | null;
  gitProvider?: `${GitProvider}` | null;
  gitProviderId?: string | null;
  dockerImage?: string | null;
  dockerComposeFile?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  /** Internal port the app listens on (container side). */
  port: number | null;
  /** True when the user pinned this port — public URL becomes https://<domain>:<port>. */
  customPort?: boolean;
  containerName?: string | null;
  containerPort?: number | null;
  /** Host-published port for domain-less apps (http://<serverIp>:<hostPort>). */
  hostPort?: number | null;
  autoDeploy?: boolean;
  envVars?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  // Relations (included on list/detail endpoints)
  project?: {
    id: string;
    name: string;
    /** Included by GET /applications/:id only. */
    server?: { id: string; name: string } | null;
  };
  domains?: DomainSummary[];
  portBindings?: ApplicationPortBinding[];
}

export interface ApplicationLogsRequest {
  applicationId: string;
  lines?: number;
  since?: string;
}
