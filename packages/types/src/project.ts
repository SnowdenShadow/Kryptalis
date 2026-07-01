import { ApplicationStatus, AppFramework, ProjectRole } from './enums';
import { DomainSummary } from './domain';

export interface CreateProjectRequest {
  name: string;
  description?: string;
}

/**
 * Application shape embedded in project responses. GET /projects selects
 * {id, name, status, framework, port}; GET /projects/:id includes the full
 * application row plus `domains`.
 */
export interface ProjectApplicationSummary {
  id: string;
  name: string;
  status: `${ApplicationStatus}`;
  framework: `${AppFramework}`;
  port: number | null;
  domains?: DomainSummary[];
}

/**
 * Project as returned by GET /projects and GET /projects/:id.
 * storageQuotaBytes is a BigInt column → serialized as a decimal string.
 */
export interface ProjectResponse {
  id: string;
  name: string;
  description: string | null;
  userId?: string;
  storageQuotaBytes?: string | null;
  createdAt: string;
  updatedAt: string;
  applications?: ProjectApplicationSummary[];
  /** Caller's membership rows — GET /projects includes `members: [{ role }]`. */
  members?: { role: `${ProjectRole}` }[];
  /** Caller's resolved role — appended by GET /projects/:id. */
  currentRole?: `${ProjectRole}`;
}
