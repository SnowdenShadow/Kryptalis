export interface MarketplaceApp {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  icon: string;
  dockerCompose: string;
  envVars: MarketplaceEnvVar[];
  ports: number[];
  version: string;
}

export interface MarketplaceEnvVar {
  key: string;
  label: string;
  defaultValue?: string;
  required: boolean;
  secret: boolean;
}

export interface InstallMarketplaceAppRequest {
  appSlug: string;
  serverId: string;
  projectId: string;
  envVars: Record<string, string>;
  domain?: string;
}
