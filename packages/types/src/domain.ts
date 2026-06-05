import { DomainStatus, SSLStatus, DNSRecordType } from './enums';

export interface CreateDomainRequest {
  domain: string;
  applicationId?: string;
  autoSsl?: boolean;
}

export interface DomainResponse {
  id: string;
  domain: string;
  applicationId: string | null;
  status: DomainStatus;
  sslStatus: SSLStatus;
  sslExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
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
