// Shapes mirror what apps/api/src/modules/docker/docker.service.ts actually
// returns — i.e. the `docker ps/images/network ls/volume ls --format
// '{{json .}}'` output remapped field-by-field. Values are raw docker CLI
// strings (human-readable sizes, "0.0.0.0:80->80/tcp" port specs, relative
// dates), NOT parsed/structured data.

/** One row of `docker ps -a` (listContainers). */
export interface ContainerResponse {
  /** Container ID (short 12-char form from `docker ps`). */
  id: string;
  /** Container name(s), e.g. "dockcontrol-api". */
  name: string;
  image: string;
  /**
   * Docker state, lowercase on the wire: "created" | "restarting" |
   * "running" | "removing" | "paused" | "exited" | "dead". Falls back to
   * 'running'/'exited' derived from the Status text when State is absent.
   */
  status: string;
  /** Raw docker port spec, e.g. "0.0.0.0:8080->80/tcp, :::8080->80/tcp". May be "". */
  ports: string;
  /** CreatedAt timestamp string, or RunningFor ("2 hours ago") as fallback. */
  created: string;
  /** Human status text, e.g. "Up 2 hours" / "Exited (0) 3 days ago". */
  state: string;
}

/** One row of `docker images` (listImages). */
export interface DockerImageResponse {
  id: string;
  /** "repo:tag" entries; empty when the image is dangling (<none>). */
  tags: string[];
  /** Human-readable size string from docker, e.g. "125MB". */
  size: string;
  /** CreatedAt timestamp string, or CreatedSince ("2 weeks ago") as fallback. */
  created: string;
}

/** One row of `docker network ls` (listNetworks). */
export interface DockerNetworkResponse {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

/** One row of `docker volume ls` (listVolumes). */
export interface DockerVolumeResponse {
  name: string;
  driver: string;
  /** Host mountpoint path; "" when docker doesn't report one. */
  mountpoint: string;
  /** Human-readable size ("N/A" unless `-s` was used); null when absent. */
  size: string | null;
  /** Always "" today — docker volume ls doesn't report creation time. */
  createdAt: string;
}

/** Body of POST /docker/servers/:serverId/containers/action. */
export interface ContainerActionRequest {
  /** 64-char hex id, 12-char short id, or container name. */
  containerId: string;
  action: 'start' | 'stop' | 'restart' | 'remove' | 'kill';
}
