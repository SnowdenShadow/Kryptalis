import { ApplicationStatus, AppFramework, GitProvider } from './enums';
import { DomainSummary } from './domain';

/** Mirrors apps/api applications/dto/create-application.dto.ts. */
export interface CreateApplicationRequest {
  name: string;
  projectId: string;
  framework: AppFramework;
  gitUrl?: string;
  gitBranch?: string;
  gitProvider?: GitProvider;
  dockerImage?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
  /** ID of a connected git provider (private repo via OAuth). */
  gitProviderId?: string;
  /** One-shot personal access token for a private git URL (not stored). */
  gitToken?: string;
  /** Override docker-compose.yml content for first deploy. */
  composeOverride?: string;
  /** Override Dockerfile content for first deploy. */
  dockerfileOverride?: string;
  /** Raw docker-compose.yml — deploys a compose stack without a git repo. */
  composeContent?: string;
  /** Raw Dockerfile — builds & deploys an image without a git repo. */
  dockerfileContent?: string;
  /** Build context files keyed by relative path (Dockerfile-only mode). */
  contextFiles?: Record<string, string>;
  /** Host port mapping override { "containerPort": hostPort }. */
  portMapping?: Record<string, number>;
  /** Existing domain to attach the app to once created. */
  domainId?: string;
  /** New domain to create + attach in one go (e.g. "app.acme.com"). */
  domain?: string;
  /** Host port to publish on for direct IP access (no-domain case). */
  hostPort?: number;
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
    /** id+name on GET /applications/:id; host on both list and detail —
     *  the dashboard derives IP:port URLs from the app's OWN server in
     *  MULTI mode (remote server ≠ the host serving the dashboard). */
    server?: { id?: string; name?: string; host?: string | null } | null;
  };
  domains?: DomainSummary[];
  portBindings?: ApplicationPortBinding[];
}

export interface ApplicationLogsRequest {
  applicationId: string;
  lines?: number;
  since?: string;
}
