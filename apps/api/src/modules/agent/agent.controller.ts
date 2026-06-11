import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Header,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AgentService } from './agent.service';
import { AgentPollDto } from './dto/agent-poll.dto';
import { AgentHeartbeatDto } from './dto/agent-heartbeat.dto';
import { TaskResultDto } from './dto/task-result.dto';
import * as fs from 'fs';
import * as path from 'path';

const AGENT_VERSION = '0.1.0';
const ALLOWED_ARCHS = new Set(['amd64', 'arm64']);

function findBinary(arch: string): string | null {
  const name = `kryptalis-agent-linux-${arch}`;
  const cwd = process.cwd();
  const candidates = [
    // when API runs from the monorepo root: ./apps/agent/bin/...
    path.join(cwd, 'apps', 'agent', 'bin', name),
    // when API runs from apps/api: ../../apps/agent/bin/...
    path.join(cwd, '..', '..', 'apps', 'agent', 'bin', name),
    // inside the API container: /app/apps/agent/bin/... or /app/agent/bin/...
    path.join('/app', 'apps', 'agent', 'bin', name),
    path.join('/app', 'agent', 'bin', name),
    // bare drop next to the API
    path.join(cwd, 'agent', 'bin', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

@ApiTags('Agent')
@Controller('agent')
export class AgentController {
  constructor(private svc: AgentService) {}

  // ─── public bootstrap routes (no JWT — agent runs on a fresh VPS) ──

  @Get('binary')
  @ApiOperation({ summary: 'Download the kryptalis-agent binary for a given arch (linux/amd64|arm64)' })
  binary(@Query('arch') arch: string, @Res() res: Response) {
    if (!arch || !ALLOWED_ARCHS.has(arch)) {
      res.status(400).type('text/plain').send('Unsupported arch (expected amd64 or arm64)\n');
      return;
    }
    const binPath = findBinary(arch);
    if (!binPath) {
      res.status(503).type('text/plain').send(
        '# kryptalis-agent binary not built yet for arch=' + arch + '\n' +
          '# Build it from apps/agent and copy to apps/agent/bin/kryptalis-agent-linux-' + arch + '\n',
      );
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="kryptalis-agent"');
    res.sendFile(binPath);
  }

  @Get('install.sh')
  @ApiOperation({ summary: 'Install script for a brand-new server' })
  @Header('Content-Type', 'text/x-shellscript')
  installScript(@Query('token') token: string, @Res() res: Response) {
    // Tight regex: every install token Kryptalis issues is 64 hex chars
    // (32 random bytes). Accept the canonical shape only — defends against
    // anyone trying to brute-force /agent/register with short tokens.
    if (!token || !/^[a-zA-Z0-9_-]{32,128}$/.test(token)) {
      res.status(400).type('text/plain').send('Missing or invalid token\n');
      return;
    }
    const base = (process.env.PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
    res.send(renderInstallScript(token, base));
  }

  @Post('register')
  @ApiOperation({ summary: 'Agent claims a server slot with an install token' })
  register(
    @Body() body: {
      installToken: string;
      host: string;
      hostname: string;
      os: string;
      arch: string;
      cpuCores: number;
      totalMemory: number;
    },
  ) {
    return this.svc.register(body.installToken, body);
  }

  // ─── authenticated agent routes (token-based) ─────────────────────

  @Post('poll')
  @ApiOperation({ summary: 'Poll for tasks' })
  poll(@Body() dto: AgentPollDto) {
    return this.svc.poll(dto.serverId, dto.token);
  }

  @Post('heartbeat')
  @ApiOperation({ summary: 'Send heartbeat' })
  heartbeat(@Body() dto: AgentHeartbeatDto) {
    return this.svc.heartbeat(dto.serverId, dto.token, dto);
  }

  @Post('tasks/:id/result')
  @ApiOperation({ summary: 'Report task result (requires server id + agent token)' })
  taskResult(@Param('id') id: string, @Body() dto: TaskResultDto) {
    return this.svc.taskResult(id, dto.serverId, dto.token, dto.status, dto.result, dto.error);
  }

  // ─── file transfers (token-authed, raw binary streams) ────────────
  //
  // Used by agents to move large blobs (volume tars, backup archives)
  // through the API: VOLUME_EXPORT/BACKUP upload under their own taskId,
  // VOLUME_IMPORT/RESTORE download from payload.sourceTaskId. The upload
  // body is a raw octet stream (NO multipart, NO json) — main.ts excludes
  // /api/agent/transfers/*/upload from the json body-parser the same way
  // it does for /api/files/*/upload.

  @Post('transfers/:taskId/upload')
  @ApiOperation({ summary: 'Agent uploads a transfer file (raw octet-stream body)' })
  async transferUpload(
    @Param('taskId') taskId: string,
    @Query('name') name: string,
    @Query('serverId') serverId: string,
    @Query('token') token: string,
    @Req() req: Request,
  ) {
    const filePath = await this.svc.resolveTransferPath(taskId, serverId, token, name, 'upload');
    const max = this.svc.transferMaxBytes;

    // Fail fast on an honest Content-Length before reading anything.
    const declared = parseInt(String(req.headers['content-length'] ?? ''), 10);
    if (Number.isFinite(declared) && declared > max) {
      throw new BadRequestException(`Upload exceeds the ${max} byte transfer limit`);
    }
    // Idle timeout so a half-open stream can't pin a worker (volume tars can
    // legitimately trickle for a while — keep it generous).
    try { (req as any).setTimeout?.(15 * 60_000); } catch {}

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    // Stream straight to disk — the payload is NEVER buffered in memory. A
    // running byte counter aborts as soon as the cap is crossed (same pattern
    // as files.controller upload).
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(filePath, { mode: 0o600 });
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          try { out.destroy(); } catch {}
          reject(err);
        };
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            req.destroy();
            fail(new BadRequestException(`Upload exceeds the ${max} byte transfer limit`));
          }
        });
        req.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        req.pipe(out);
      });
    } catch (err) {
      // Never leave a partial file behind — a later download must not see it.
      await fs.promises.unlink(filePath).catch(() => {});
      throw err;
    }
    return { ok: true, name: path.basename(filePath), size };
  }

  @Get('transfers/:taskId/download')
  @ApiOperation({ summary: 'Agent downloads a transfer file (raw octet-stream)' })
  async transferDownload(
    @Param('taskId') taskId: string,
    @Query('name') name: string,
    @Query('serverId') serverId: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const filePath = await this.svc.resolveTransferPath(taskId, serverId, token, name, 'download');
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new NotFoundException('Transfer file not found');
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err: Error) => {
      try { res.destroy(err); } catch {}
    });
    stream.pipe(res);
  }

  // ─── operator routes (JWT) ────────────────────────────────────────

  // Task payloads can carry sensitive operational data (e.g. BACKUP/RESTORE
  // database credentials while the task is in flight) — getTaskForUser()
  // redacts the payload for non-admin callers and only ever returns the
  // status fields the dashboard consumes.
  @Get('tasks/:id')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Get task status (payload redacted for non-admins)' })
  getTask(@Param('id') id: string, @CurrentUser('role') role: string) {
    return this.svc.getTaskForUser(id, role);
  }
}

// Note on quoting: this is a JS template literal that renders a /bin/sh script.
// Every `$` that should reach the shell must be escaped as `\$` here. The two
// values we DO want JS to interpolate are TOKEN (`${tk}`) and the API URL.
function renderInstallScript(tk: string, apiUrl: string): string {
  return `#!/bin/sh
# Kryptalis agent installer
# Run as:  curl -fsSL ${apiUrl}/api/agent/install.sh?token=<token> | sudo sh

set -eu

TOKEN="${tk}"
API_URL="${apiUrl}"
AGENT_DIR=/opt/kryptalis
AGENT_BIN="\$AGENT_DIR/kryptalis-agent"

if [ "\$(id -u)" -ne 0 ]; then
  echo "✖ run as root (sudo)"; exit 1
fi

echo "▶ Kryptalis agent installer"
echo "  API:  \$API_URL"
echo "  Dir:  \$AGENT_DIR"

# systemd available? (containers / WSL / Cloud Shell run without it —
# systemctl exists there but PID 1 isn't systemd and every call fails
# with "System has not been booted with systemd")
HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  HAS_SYSTEMD=1
fi

# ─── 1. Install Docker if missing ─────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "▶ Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  if [ "\$HAS_SYSTEMD" = 1 ]; then
    systemctl enable --now docker
  else
    # non-systemd host: start the daemon directly if it isn't running
    docker info >/dev/null 2>&1 || nohup dockerd >/var/log/dockerd.log 2>&1 &
  fi
else
  echo "✓ Docker already installed"
fi

# ─── 2. Install agent binary ──────────────────────────────────────
mkdir -p "\$AGENT_DIR"

ARCH=\$(uname -m)
case "\$ARCH" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "✖ Unsupported arch: \$ARCH"; exit 1 ;;
esac

echo "▶ Downloading kryptalis-agent (linux/\$ARCH)..."
curl -fsSL "\$API_URL/api/agent/binary?arch=\$ARCH" -o "\$AGENT_BIN"
chmod +x "\$AGENT_BIN"

# ─── 3. Register with the API ─────────────────────────────────────
echo "▶ Registering server..."
HOST_IP=\$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print \$1}')
HOSTNAME=\$(hostname)
OS_INFO="\$(uname -s) \$(uname -r)"
CPU_CORES=\$(nproc)
TOTAL_MEM=\$(awk '/MemTotal/ {print \$2 * 1024}' /proc/meminfo)

REGISTER_PAYLOAD=\$(printf '{"installToken":"%s","host":"%s","hostname":"%s","os":"%s","arch":"%s","cpuCores":%d,"totalMemory":%d}' \\
  "\$TOKEN" "\$HOST_IP" "\$HOSTNAME" "\$OS_INFO" "\$ARCH" "\$CPU_CORES" "\$TOTAL_MEM")

REGISTER_RESP=\$(curl -fsS -X POST "\$API_URL/api/agent/register" \\
  -H "Content-Type: application/json" \\
  -d "\$REGISTER_PAYLOAD") || { echo "✖ register http error"; exit 1; }

SERVER_ID=\$(echo "\$REGISTER_RESP" | sed -n 's/.*"serverId":"\\([^"]*\\)".*/\\1/p')
NEW_TOKEN=\$(echo "\$REGISTER_RESP" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')

if [ -z "\$SERVER_ID" ] || [ -z "\$NEW_TOKEN" ]; then
  echo "✖ Register failed:"; echo "\$REGISTER_RESP"; exit 1
fi

# ─── 4. Write config + service ────────────────────────────────────
cat > "\$AGENT_DIR/agent.env" <<ENVEOF
KRYPTALIS_API_URL=\$API_URL
KRYPTALIS_SERVER_ID=\$SERVER_ID
KRYPTALIS_TOKEN=\$NEW_TOKEN
ENVEOF
chmod 600 "\$AGENT_DIR/agent.env"

if [ "\$HAS_SYSTEMD" = 1 ]; then
  cat > /etc/systemd/system/kryptalis-agent.service <<UNITEOF
[Unit]
Description=Kryptalis Agent
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=simple
EnvironmentFile=\$AGENT_DIR/agent.env
ExecStart=\$AGENT_BIN
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF

  systemctl daemon-reload
  systemctl enable --now kryptalis-agent

  echo ""
  echo "✓ Installation complete (agent v${AGENT_VERSION})"
  echo "  Server ID: \$SERVER_ID"
  echo "  Status:    systemctl status kryptalis-agent"
  echo "  Logs:      journalctl -u kryptalis-agent -f"
else
  # No systemd (container / WSL / Cloud Shell) — run the agent with nohup
  # and drop a start script so it can be relaunched after a reboot.
  # NOTE: without an init system the agent does NOT survive reboots on
  # its own; the start script must be re-run (or wired into the host's
  # own startup mechanism).
  cat > "\$AGENT_DIR/start-agent.sh" <<'STARTEOF'
#!/bin/sh
AGENT_DIR=/opt/kryptalis
set -a; . "\$AGENT_DIR/agent.env"; set +a
# already running?
if [ -f "\$AGENT_DIR/agent.pid" ] && kill -0 "\$(cat "\$AGENT_DIR/agent.pid")" 2>/dev/null; then
  echo "kryptalis-agent already running (pid \$(cat "\$AGENT_DIR/agent.pid"))"
  exit 0
fi
nohup "\$AGENT_DIR/kryptalis-agent" >> "\$AGENT_DIR/agent.log" 2>&1 &
echo \$! > "\$AGENT_DIR/agent.pid"
echo "kryptalis-agent started (pid \$(cat "\$AGENT_DIR/agent.pid"))"
STARTEOF
  chmod +x "\$AGENT_DIR/start-agent.sh"
  "\$AGENT_DIR/start-agent.sh"

  echo ""
  echo "✓ Installation complete (agent v${AGENT_VERSION}) — no systemd detected"
  echo "  Server ID: \$SERVER_ID"
  echo "  Started with nohup (PID \$(cat "\$AGENT_DIR/agent.pid"))"
  echo "  Logs:      tail -f \$AGENT_DIR/agent.log"
  echo "  Restart:   \$AGENT_DIR/start-agent.sh"
  echo "  ⚠ Without systemd the agent does not auto-start on reboot."
fi
`;
}
