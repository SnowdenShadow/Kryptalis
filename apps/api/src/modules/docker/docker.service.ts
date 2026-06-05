import { Injectable } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class DockerService {
  async listContainers(_serverId: string) {
    try {
      const { stdout } = await execAsync('docker ps -a --format "{{json .}}"', { timeout: 10000 });
      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const c = JSON.parse(line);
        return {
          id: c.ID,
          name: c.Names,
          image: c.Image,
          status: c.State || (c.Status?.includes('Up') ? 'running' : 'exited'),
          ports: c.Ports || '',
          created: c.CreatedAt || c.RunningFor,
          state: c.Status,
        };
      });
    } catch { return []; }
  }

  async containerAction(_serverId: string, containerId: string, action: string) {
    try {
      await execAsync(`docker ${action} ${containerId}`, { timeout: 30000 });
      return { message: `Container ${action} successful` };
    } catch (err: any) {
      return { message: err.message || `Container ${action} failed` };
    }
  }

  async listImages(_serverId: string) {
    try {
      const { stdout } = await execAsync('docker images --format "{{json .}}"', { timeout: 10000 });
      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const img = JSON.parse(line);
        return { id: img.ID, tags: [img.Repository + ':' + img.Tag].filter(t => !t.includes('<none>')), size: img.Size, created: img.CreatedAt || img.CreatedSince };
      });
    } catch { return []; }
  }

  async listNetworks(_serverId: string) {
    try {
      const { stdout } = await execAsync('docker network ls --format "{{json .}}"', { timeout: 10000 });
      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const n = JSON.parse(line);
        return { id: n.ID, name: n.Name, driver: n.Driver, scope: n.Scope };
      });
    } catch { return []; }
  }

  async listVolumes(_serverId: string) {
    try {
      const { stdout } = await execAsync('docker volume ls --format "{{json .}}"', { timeout: 10000 });
      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const v = JSON.parse(line);
        return { name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint || '', size: v.Size || null, createdAt: '' };
      });
    } catch { return []; }
  }
}
