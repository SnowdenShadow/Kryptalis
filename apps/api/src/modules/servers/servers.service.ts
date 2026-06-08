import { Injectable, NotFoundException, BadRequestException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { UpdateServerDto } from './dto/update-server.dto';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';

const execAsync = promisify(exec);

@Injectable()
export class ServersService implements OnModuleInit, OnModuleDestroy {
  private collectInterval: ReturnType<typeof setInterval> | null = null;
  private prevNet: { rx: number; tx: number; ts: number } | null = null;

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  /** Generate a fresh install/agent token and return both raw + hash. */
  private mintToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('hex');
    return { raw, hash: this.encryption.hash(raw) };
  }

  async onModuleInit() {
    this.collectInterval = setInterval(() => this.collectMetrics(), 30000);
    setTimeout(() => this.collectMetrics(), 2000);
  }

  async onModuleDestroy() {
    if (this.collectInterval) {
      clearInterval(this.collectInterval);
      this.collectInterval = null;
    }
  }

  async findAll() {
    return this.prisma.server.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Public, sanitized snapshot of the local server. Safe for any
   * authenticated user — needed by the dashboard's "create project"
   * flow in LOCAL mode (the form has to know there's a local target
   * before letting the user submit). No tokens, no remote IPs.
   */
  async findLocalPublic() {
    const local = await this.prisma.server.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, status: true, os: true, arch: true },
    });
    return local;
  }

  /**
   * Sanitized list of servers the caller can reach via project membership.
   * Used by the dashboard sidebar / project picker. Never includes
   * agentTokens, IPs of remote servers, or other infra secrets.
   */
  async findAccessible(userId: string) {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { project: { select: { serverId: true } } },
    });
    const ids = Array.from(new Set(memberships.map((m) => m.project.serverId).filter(Boolean)));
    if (ids.length === 0) return [];
    const rows = await this.prisma.server.findMany({
      where: { id: { in: ids as string[] } },
      select: { id: true, name: true, host: true, status: true, os: true, arch: true },
    });
    return rows;
  }

  async findLocal() {
    let server = await this.prisma.server.findFirst({
      include: { agentTokens: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!server) {
      server = await this.prisma.server.create({
        data: {
          name: 'Local Server',
          host: '127.0.0.1',
          port: 22,
          username: 'root',
          status: 'ONLINE',
        },
        include: { agentTokens: true },
      });

      // Bootstrap token for the built-in local server. Stored as hash; the
      // raw value isn't exposed via any endpoint because the in-process
      // agent doesn't need it (LOCAL mode shells out directly).
      const { hash } = this.mintToken();
      await this.prisma.agentToken.create({
        data: { serverId: server.id, token: hash },
      });

      server = await this.prisma.server.findFirst({
        where: { id: server.id },
        include: { agentTokens: true },
      });
    }

    return server;
  }

  async setupLocal() {
    const server = await this.findLocal();
    if (!server) return null;

    const disk = await this.getDiskUsage();

    const updated = await this.prisma.server.update({
      where: { id: server.id },
      data: {
        name: os.hostname() || 'Local Server',
        host: '127.0.0.1',
        status: 'ONLINE',
        os: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        cpuCores: os.cpus().length,
        totalMemory: BigInt(os.totalmem()),
        totalDisk: BigInt(disk.total),
        agentVersion: 'built-in',
        lastSeenAt: new Date(),
      },
      include: { agentTokens: true },
    });

    await this.collectMetrics();
    return updated;
  }

  private async collectMetrics() {
    try {
      const server = await this.prisma.server.findFirst({ orderBy: { createdAt: 'asc' } });
      if (!server) return;

      const cpus = os.cpus();
      const cpuPercent = cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        return acc + ((total - cpu.times.idle) / total) * 100;
      }, 0) / cpus.length;

      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      const disk = await this.getDiskUsage();
      const net = await this.getNetworkBytes();

      await this.prisma.serverMetric.create({
        data: {
          serverId: server.id,
          cpuPercent: Math.round(cpuPercent * 100) / 100,
          memoryUsed: BigInt(usedMem),
          memoryTotal: BigInt(totalMem),
          diskUsed: BigInt(disk.used),
          diskTotal: BigInt(disk.total),
          networkIn: BigInt(net.rx),
          networkOut: BigInt(net.tx),
        },
      });

      await this.prisma.server.update({
        where: { id: server.id },
        data: { status: 'ONLINE', lastSeenAt: new Date() },
      });
    } catch {}
  }

  private async getDiskUsage(): Promise<{ used: number; total: number }> {
    try {
      if (os.platform() === 'win32') {
        // Sum across every fixed drive (C:, D:, …) instead of hard-coding C.
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null } | ForEach-Object { ($_.Used + $_.Free).ToString() + \',\' + $_.Used.ToString() }"',
          { timeout: 5000 },
        );
        let total = 0, used = 0;
        for (const line of stdout.trim().split(/\r?\n/)) {
          const [t, u] = line.split(',').map(Number);
          if (Number.isFinite(t) && t > 0) {
            total += t;
            used += u || 0;
          }
        }
        if (total > 0) return { used, total };
      } else {
        const { stdout } = await execAsync("df -B1 / | tail -1 | awk '{print $3, $2}'", { timeout: 5000 });
        const [used, total] = stdout.trim().split(/\s+/).map(Number);
        return { used: used || 0, total: total || 0 };
      }
    } catch {}
    return { used: 0, total: 0 };
  }

  /**
   * Real per-second network throughput. Reads /proc/net/dev on Linux and
   * keeps a snapshot between collects so the dashboard graph is bytes/sec,
   * not cumulative totals.
   */
  private async getNetworkBytes(): Promise<{ rx: number; tx: number }> {
    if (os.platform() !== 'linux') return { rx: 0, tx: 0 };
    try {
      const text = fs.readFileSync('/proc/net/dev', 'utf-8');
      let rxTotal = 0, txTotal = 0;
      for (const raw of text.split('\n').slice(2)) {
        const line = raw.trim();
        if (!line) continue;
        const [iface, rest] = line.split(':');
        if (!rest || iface === 'lo') continue;
        const cols = rest.trim().split(/\s+/).map(Number);
        if (cols.length < 16) continue;
        rxTotal += cols[0] || 0;
        txTotal += cols[8] || 0;
      }
      const now = Date.now();
      const prev = this.prevNet;
      this.prevNet = { rx: rxTotal, tx: txTotal, ts: now };
      if (!prev) return { rx: 0, tx: 0 };
      const dt = Math.max(1, (now - prev.ts) / 1000);
      return {
        rx: Math.max(0, Math.round((rxTotal - prev.rx) / dt)),
        tx: Math.max(0, Math.round((txTotal - prev.tx) / dt)),
      };
    } catch {
      return { rx: 0, tx: 0 };
    }
  }

  async getLocalStats() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const disk = await this.getDiskUsage();
    const uptimeSeconds = os.uptime();

    const cpuPerCore = cpus.map((cpu, i) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return { core: i, model: cpu.model, speed: cpu.speed, usage: Math.round(((total - idle) / total) * 100 * 10) / 10 };
    });
    const cpuAvg = cpuPerCore.reduce((a, c) => a + c.usage, 0) / cpuPerCore.length;

    const loadAvg = os.loadavg();

    let topProcesses: any[] = [];
    try {
      if (os.platform() === 'win32') {
        const { stdout } = await execAsync('powershell -Command "Get-Process | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 10 | ForEach-Object { $_.Name + \",\" + [math]::Round($_.WorkingSet64/1MB,1) + \",\" + [math]::Round($_.CPU,1) }"', { timeout: 5000 });
        topProcesses = stdout.trim().split('\n').filter(Boolean).map(line => {
          const [name, memMB, cpuTime] = line.trim().split(',');
          return { name, memoryMB: parseFloat(memMB) || 0, cpuTime: parseFloat(cpuTime) || 0 };
        });
      } else {
        const { stdout } = await execAsync("ps aux --sort=-%mem | head -11 | tail -10 | awk '{print $11\",\"$6/1024\",\"$3}'", { timeout: 5000 });
        topProcesses = stdout.trim().split('\n').filter(Boolean).map(line => {
          const [name, memMB, cpuPct] = line.trim().split(',');
          return { name: name.split('/').pop(), memoryMB: parseFloat(memMB) || 0, cpuPercent: parseFloat(cpuPct) || 0 };
        });
      }
    } catch {}

    let dockerContainers: any[] = [];
    try {
      const { stdout } = await execAsync('docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"', { timeout: 5000 });
      dockerContainers = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [name, status, image, ports] = line.split('\t');
        return { name, status, image, ports };
      });
    } catch {}

    const networkInterfaces = Object.entries(os.networkInterfaces())
      .filter(([, addrs]) => addrs?.some(a => !a.internal))
      .map(([name, addrs]) => ({
        name,
        addresses: addrs?.filter(a => !a.internal).map(a => ({ address: a.address, family: a.family })) || [],
      }));

    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime: { seconds: uptimeSeconds, formatted: `${days}d ${hours}h ${minutes}m` },
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model || 'Unknown',
        average: Math.round(cpuAvg * 10) / 10,
        perCore: cpuPerCore,
      },
      loadAverage: { '1m': loadAvg[0], '5m': loadAvg[1], '15m': loadAvg[2] },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percent: Math.round((usedMem / totalMem) * 100),
      },
      disk: {
        total: disk.total,
        used: disk.used,
        free: disk.total - disk.used,
        percent: disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0,
      },
      network: { interfaces: networkInterfaces },
      topProcesses,
      dockerContainers,
    };
  }

  async findOne(id: string) {
    const server = await this.prisma.server.findUnique({
      where: { id },
      include: { projects: true },
    });
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  async update(id: string, dto: UpdateServerDto) {
    await this.findOne(id);
    return this.prisma.server.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.server.delete({ where: { id } });
    return { message: 'Server deleted' };
  }

  // ── multi-server: create a pending server + install token ─────────

  /**
   * Create a server in PENDING_INSTALL state and return a one-shot install token.
   * The user runs `curl <api>/agent/install.sh?token=<token> | sh` on their VPS,
   * which downloads the agent and calls /agent/register with the same token to
   * claim the server slot.
   */
  async createPending(payload: { name: string; host?: string }) {
    const server = await this.prisma.server.create({
      data: {
        name: payload.name,
        host: payload.host || 'pending',
        port: 22,
        username: 'root',
        status: 'PENDING_INSTALL',
      },
    });
    const { raw, hash } = this.mintToken();
    await this.prisma.agentToken.create({
      data: {
        serverId: server.id,
        token: hash,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000), // valid 24h to claim
      },
    });
    return {
      ...server,
      installToken: raw,
      installCommand: `curl -fsSL ${this.publicApiUrl()}/api/agent/install.sh?token=${raw} | sudo sh`,
    };
  }

  private publicApiUrl() {
    return (process.env.PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
  }

  async getInstallCommand(id: string) {
    const server = await this.prisma.server.findUnique({
      where: { id },
      include: {
        agentTokens: {
          where: { expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!server) throw new NotFoundException('Server not found');
    // We don't have the raw token after creation — the DB stores a hash.
    // If an active token row exists we cannot return its raw form. Mint a
    // new one and superseded the old.
    await this.prisma.agentToken.deleteMany({
      where: { serverId: id, expiresAt: { gt: new Date() } },
    });
    const { raw, hash } = this.mintToken();
    await this.prisma.agentToken.create({
      data: { serverId: server.id, token: hash, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
    });
    return {
      installCommand: `curl -fsSL ${this.publicApiUrl()}/api/agent/install.sh?token=${raw} | sudo sh`,
      token: raw,
    };
  }

  /**
   * Force-regenerate the install token, invalidating any older one.
   * Used by admins to rotate creds before sending the install command.
   */
  async regenerateInstallToken(id: string) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    // delete any existing one-shot or unbound tokens for this server
    await this.prisma.agentToken.deleteMany({
      where: { serverId: id },
    });
    const { raw, hash } = this.mintToken();
    await this.prisma.agentToken.create({
      data: {
        serverId: id,
        token: hash,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    // Tag the raw token onto the returned object so the caller can echo it.
    // This is the only point at which the raw token exists outside the
    // agent's own memory.
    // back to PENDING_INSTALL so the agent re-registers and re-establishes long-token
    if (server.status === 'ONLINE') {
      await this.prisma.server.update({
        where: { id },
        data: { status: 'PENDING_INSTALL' },
      });
    }
    return {
      installCommand: `curl -fsSL ${this.publicApiUrl()}/api/agent/install.sh?token=${raw} | sudo sh`,
      token: raw,
    };
  }

  /**
   * Reset a server — wipe all metrics, mark OFFLINE, clear agent tokens, generate
   * a fresh install token. Projects/apps that point at it stay in DB but become
   * unreachable until a new agent is installed.
   */
  async reset(id: string) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    await this.prisma.$transaction([
      this.prisma.serverMetric.deleteMany({ where: { serverId: id } }),
      this.prisma.agentToken.deleteMany({ where: { serverId: id } }),
      this.prisma.server.update({
        where: { id },
        data: {
          status: 'PENDING_INSTALL',
          agentVersion: null,
          lastSeenAt: null,
          os: null,
          arch: null,
          cpuCores: null,
          totalMemory: null,
          totalDisk: null,
        },
      }),
    ]);
    const fresh = await this.regenerateInstallToken(id);
    return {
      message: 'Server reset — agent must re-register',
      ...fresh,
    };
  }

  /**
   * Delete a server. Refuses if any project still uses it (the operator must
   * move/delete the projects first) — unless `force` is passed.
   */
  async removeChecked(id: string, force = false) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    const projectCount = await this.prisma.project.count({ where: { serverId: id } });
    if (projectCount > 0 && !force) {
      throw new BadRequestException(
        `Server has ${projectCount} project(s). Move them or pass force=true to delete with all projects.`,
      );
    }
    await this.prisma.server.delete({ where: { id } });
    return { message: 'Server deleted', cascadedProjects: projectCount };
  }
}
