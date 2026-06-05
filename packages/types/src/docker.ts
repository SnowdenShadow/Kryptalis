import { ContainerStatus } from './enums';

export interface ContainerResponse {
  id: string;
  name: string;
  image: string;
  status: ContainerStatus;
  ports: PortMapping[];
  created: string;
  state: string;
}

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  protocol: string;
}

export interface DockerImageResponse {
  id: string;
  tags: string[];
  size: number;
  created: string;
}

export interface DockerNetworkResponse {
  id: string;
  name: string;
  driver: string;
  scope: string;
  containers: string[];
}

export interface DockerVolumeResponse {
  name: string;
  driver: string;
  mountpoint: string;
  size: number | null;
  createdAt: string;
}

export interface ContainerActionRequest {
  containerId: string;
  action: 'start' | 'stop' | 'restart' | 'remove';
}
