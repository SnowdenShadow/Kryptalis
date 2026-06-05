export interface CreateProjectRequest {
  name: string;
  description?: string;
  serverId: string;
}

export interface ProjectResponse {
  id: string;
  name: string;
  description: string | null;
  serverId: string;
  createdAt: string;
  updatedAt: string;
}
