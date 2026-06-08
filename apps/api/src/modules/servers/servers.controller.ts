import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ServersService } from './servers.service';
import { UpdateServerDto } from './dto/update-server.dto';
import { AdminService } from '../admin/admin.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

/**
 * /servers exposes two surfaces:
 *
 * - **Admin-only platform CRUD** (everything except /mine): provisioning,
 *   install tokens, host stats, mutation. The earlier shape leaked the
 *   `agentTokens` secret (32-byte hex) to any authenticated user via
 *   /servers/local — that's a remote-code-execution primitive because the
 *   token authorizes arbitrary task enqueue against the host. Now gated to
 *   ADMIN/SUPERADMIN.
 *
 * - **Per-user view** (/servers/mine): a thin, sanitized read of the
 *   servers the caller can actually reach via project membership. No
 *   tokens, no host stats, no internals — just the metadata the dashboard
 *   needs to render server names next to projects.
 */
@ApiTags('Servers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('servers')
export class ServersController {
  constructor(
    private serversService: ServersService,
    private admin: AdminService,
  ) {}

  // ── Per-user (sanitized) views ─────────────────────────────────

  @Get('mine')
  @ApiOperation({ summary: 'List servers the caller can reach via project membership (sanitized)' })
  findMine(@CurrentUser('id') userId: string) {
    return this.serversService.findAccessible(userId);
  }

  @Get('local-public')
  @ApiOperation({ summary: 'Sanitized local server info (any authenticated user). No tokens, no IPs of remote servers.' })
  findLocalPublic() {
    return this.serversService.findLocalPublic();
  }

  // ── Admin platform CRUD ─────────────────────────────────────────

  @Get()
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'List all servers (admin only)' })
  findAll() {
    return this.serversService.findAll();
  }

  @Post()
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Create a new (pending) server and return install command' })
  async create(@Body() body: { name: string; host?: string }) {
    const mode = await this.admin.getDeploymentMode();
    if (mode === 'LOCAL') {
      throw new BadRequestException(
        'Adding servers is disabled in LOCAL deployment mode. Switch to MULTI in admin settings first.',
      );
    }
    return this.serversService.createPending(body);
  }

  @Get(':id/install-command')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Get (or regenerate) the install command for a server' })
  installCommand(@Param('id') id: string) {
    return this.serversService.getInstallCommand(id);
  }

  @Get('local')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Get the local server (admin — includes credentials)' })
  findLocal() {
    return this.serversService.findLocal();
  }

  @Post('local/setup')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Setup local server with system info' })
  setupLocal() {
    return this.serversService.setupLocal();
  }

  @Get('local/stats')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Get detailed live server stats' })
  getLocalStats() {
    return this.serversService.getLocalStats();
  }

  @Get(':id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Get server by ID (admin — includes credentials)' })
  findOne(@Param('id') id: string) {
    return this.serversService.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Update server' })
  update(@Param('id') id: string, @Body() dto: UpdateServerDto) {
    return this.serversService.update(id, dto);
  }

  @Post(':id/regen-token')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Force-regenerate the install token' })
  regenToken(@Param('id') id: string) {
    return this.serversService.regenerateInstallToken(id);
  }

  @Post(':id/reset')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Reset a server back to PENDING_INSTALL' })
  reset(@Param('id') id: string) {
    return this.serversService.reset(id);
  }

  @Delete(':id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Delete a server. Use ?force=true to cascade projects.' })
  remove(@Param('id') id: string, @Body() body: { force?: boolean } = {}) {
    return this.serversService.removeChecked(id, body.force);
  }
}
