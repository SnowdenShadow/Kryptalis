import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Res,
  UseGuards,
  Header,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
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
    if (!token || !/^[a-zA-Z0-9_-]{8,128}$/.test(token)) {
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

  // ─── operator routes (JWT) ────────────────────────────────────────

  @Get('tasks/:id')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Get task status' })
  getTask(@Param('id') id: string) {
    return this.svc.getTask(id);
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

# ─── 1. Install Docker if missing ─────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "▶ Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
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

# ─── 4. Write config + systemd unit ───────────────────────────────
cat > "\$AGENT_DIR/agent.env" <<ENVEOF
KRYPTALIS_API_URL=\$API_URL
KRYPTALIS_SERVER_ID=\$SERVER_ID
KRYPTALIS_TOKEN=\$NEW_TOKEN
ENVEOF
chmod 600 "\$AGENT_DIR/agent.env"

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
`;
}
