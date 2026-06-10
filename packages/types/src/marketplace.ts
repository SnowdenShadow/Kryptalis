// Shapes mirror apps/api/src/modules/marketplace/marketplace.service.ts and
// the catalog it serves (apps/api/src/modules/marketplace/catalog.json).

/** Declared env var the install wizard surfaces in the UI (catalog.json). */
export interface MarketplaceEnvVar {
  key: string;
  defaultValue: string;
  required: boolean;
  description: string;
}

/** One catalog entry — returned verbatim by GET /marketplace. */
export interface MarketplaceApp {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  icon: string;
  /** Public icon URL (dashboard-icons CDN) for the marketplace UI. */
  iconUrl?: string;
  version: string;
  /** Docker image used by the install template (informational). */
  dockerImage?: string;
  /** Default host ports the template publishes. Index 0 is the canonical one. */
  ports: number[];
  /** Internal port the container actually listens on. Caddy proxies here. */
  containerPort: number;
  /** Canonical default host port (mirrors ports[0]) — convenience for UI. */
  defaultPort?: number;
  /** Declared env vars the install wizard surfaces in the UI. */
  envVars?: MarketplaceEnvVar[];
}

/** Body of POST /marketplace/install (MarketplaceService.install). */
export interface InstallMarketplaceAppRequest {
  appSlug: string;
  projectId: string;
  /** Optional; must match the project's server when provided. */
  serverId?: string;
  /** Custom app name. Falls back to the catalog name + suffix. */
  name?: string;
  domainId?: string;
  /** Convenience: new domain to create + attach atomically. */
  newDomain?: string;
  /** Host port for direct IP access (no domain case). */
  hostPort?: number;
  /** Explicit host port pick — wins over the template default. */
  port?: number;
  envVars?: Record<string, string>;
}
