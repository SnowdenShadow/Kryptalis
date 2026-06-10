import { DomainStatus, SSLStatus, DNSRecordType } from './enums';

export interface CreateDomainRequest {
  domain: string;
  projectId?: string;
  applicationId?: string;
  autoSsl?: boolean;
}

/**
 * Compact domain shape embedded in application/project responses
 * (`domains: { select: { id, domain, sslStatus } }` in the API services).
 * `status` is only present on some endpoints (e.g. GET /applications/:id).
 */
export interface DomainSummary {
  id: string;
  domain: string;
  sslStatus: `${SSLStatus}`;
  status?: `${DomainStatus}`;
}

export interface DomainResponse {
  id: string;
  domain: string;
  projectId: string | null;
  applicationId: string | null;
  status: `${DomainStatus}`;
  sslStatus: `${SSLStatus}`;
  sslExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Relations included by GET /domains
  project?: { id: string; name: string } | null;
  application?: {
    id: string;
    name: string;
    project?: { id: string; name: string };
  } | null;
  /** Attached mail server, appended by GET /domains (null when none). */
  mailServer?: { domainId: string; status: string; hostname: string } | null;
}

export interface DNSRecord {
  id: string;
  domainId: string;
  type: DNSRecordType;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
}

export interface CreateDNSRecordRequest {
  domainId: string;
  type: DNSRecordType;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
}
