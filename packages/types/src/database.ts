import { DatabaseType } from './enums';

export interface CreateDatabaseRequest {
  name: string;
  type: DatabaseType;
  serverId: string;
  username?: string;
  password?: string;
  /** Attach the database to a project (recommended). */
  projectId?: string;
  /** Attach the database to a specific application. */
  applicationId?: string;
}

/**
 * Database as returned by GET /databases and GET /databases/:id.
 * Both endpoints append the live container `status` and a computed
 * `connectionString`. `size` is a BigInt column → decimal string.
 */
export interface DatabaseResponse {
  id: string;
  name: string;
  type: `${DatabaseType}`;
  serverId: string;
  projectId: string | null;
  applicationId: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  size: string | null;
  /** True when created by the compose/marketplace auto-importer. */
  autoImported: boolean;
  /** Compose service name for auto-imported rows. */
  serviceName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Live container status (docker-style string), appended by the API. */
  status: string;
  /** Ready-to-paste connection URI, appended by the API. */
  connectionString: string;
  /**
   * Container→container target: what ANOTHER app/container in this project must
   * use to reach the DB — its container name + INTERNAL port (e.g. 3306), NOT
   * localhost:<published-port>. This is the address to paste into PrestaShop /
   * WordPress / etc. running on the same host.
   */
  inNetwork?: { host: string; port: number; url: string };
  project?: { id: string; name: string } | null;
  application?: { id: string; name: string } | null;
}
