import { DatabaseType } from './enums';

export interface CreateDatabaseRequest {
  name: string;
  type: DatabaseType;
  serverId: string;
  username?: string;
  password?: string;
}

export interface DatabaseResponse {
  id: string;
  name: string;
  type: DatabaseType;
  serverId: string;
  host: string;
  port: number;
  username: string;
  size: number | null;
  createdAt: string;
  updatedAt: string;
}
