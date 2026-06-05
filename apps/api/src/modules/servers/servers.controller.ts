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
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ServersService } from './servers.service';
import { UpdateServerDto } from './dto/update-server.dto';
import { AdminService } from '../admin/admin.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN']);

@ApiTags('Servers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('servers')
export class ServersController {
  constructor(
    private serversService: ServersService,
    private admin: AdminService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all servers' })
  findAll() {
    return this.serversService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new (pending) server and return install command (ADMIN+)' })
  async create(
    @CurrentUser() user: { id: string; role: string },
    @Body() body: { name: string; host?: string },
  ) {
    if (!ADMIN_ROLES.has(user.role)) {
      throw new ForbiddenException('Only platform admins can add servers');
    }
    const mode = await this.admin.getDeploymentMode();
    if (mode === 'LOCAL') {
      throw new BadRequestException('Adding servers is disabled in LOCAL deployment mode. Switch to MULTI in admin settings first.');
    }
    return this.serversService.createPending(body);
  }

  @Get(':id/install-command')
  @ApiOperation({ summary: 'Get (or regenerate) the install command for a server (ADMIN+)' })
  installCommand(
    @CurrentUser() user: { id: string; role: string },
    @Param('id') id: string,
  ) {
    if (!ADMIN_ROLES.has(user.role)) {
      throw new ForbiddenException('Only platform admins can manage server credentials');
    }
    return this.serversService.getInstallCommand(id);
  }

  @Get('local')
  @ApiOperation({ summary: 'Get the local server' })
  findLocal() {
    return this.serversService.findLocal();
  }

  @Post('local/setup')
  @ApiOperation({ summary: 'Setup local server with system info' })
  setupLocal() {
    return this.serversService.setupLocal();
  }

  @Get('local/stats')
  @ApiOperation({ summary: 'Get detailed live server stats' })
  getLocalStats() {
    return this.serversService.getLocalStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get server by ID' })
  findOne(@Param('id') id: string) {
    return this.serversService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update server' })
  update(@Param('id') id: string, @Body() dto: UpdateServerDto) {
    return this.serversService.update(id, dto);
  }

  @Post(':id/regen-token')
  @ApiOperation({ summary: 'Force-regenerate the install token (ADMIN+)' })
  regenToken(@CurrentUser() user: { role: string }, @Param('id') id: string) {
    if (!ADMIN_ROLES.has(user.role)) {
      throw new ForbiddenException('Only platform admins can rotate server credentials');
    }
    return this.serversService.regenerateInstallToken(id);
  }

  @Post(':id/reset')
  @ApiOperation({ summary: 'Reset a server back to PENDING_INSTALL (ADMIN+)' })
  reset(@CurrentUser() user: { role: string }, @Param('id') id: string) {
    if (!ADMIN_ROLES.has(user.role)) {
      throw new ForbiddenException('Only platform admins can reset servers');
    }
    return this.serversService.reset(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a server (ADMIN+). Use ?force=true to cascade projects.' })
  remove(
    @CurrentUser() user: { role: string },
    @Param('id') id: string,
    @Body() body: { force?: boolean } = {},
  ) {
    if (!ADMIN_ROLES.has(user.role)) {
      throw new ForbiddenException('Only platform admins can delete servers');
    }
    return this.serversService.removeChecked(id, body.force);
  }
}
