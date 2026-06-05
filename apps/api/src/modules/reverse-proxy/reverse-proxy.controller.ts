import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ReverseProxyService } from './reverse-proxy.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Reverse Proxy')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN', 'SUPERADMIN')
@Controller('reverse-proxy')
export class ReverseProxyController {
  constructor(private svc: ReverseProxyService) {}

  @Get('status')
  @ApiOperation({ summary: 'Caddy container status' })
  status() {
    return this.svc.status();
  }

  @Post('sync')
  @ApiOperation({ summary: 'Regenerate the Caddyfile and reload Caddy' })
  sync() {
    return this.svc.regenerate();
  }

  @Post('start')
  @ApiOperation({ summary: 'Start (or re-create) the Caddy container' })
  start() {
    return this.svc.ensureRunning();
  }

  @Post('stop')
  @ApiOperation({ summary: 'Stop the Caddy container' })
  stop() {
    return this.svc.stop();
  }
}
