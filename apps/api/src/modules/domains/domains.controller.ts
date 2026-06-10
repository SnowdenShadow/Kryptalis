import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DomainsService } from './domains.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import { TransferDomainDto } from './dto/transfer-domain.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Domains')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('domains')
export class DomainsController {
  constructor(private svc: DomainsService) {}

  // Each domain attach kicks off a Let's Encrypt cert issue via Caddy.
  // LE enforces a hard 50 certs/week per registered domain — if we don't
  // throttle the API a malicious or buggy client can blow that ceiling
  // in seconds and break ALL future cert issuance for the tenant. 10
  // attach/min per IP is conservative; production users adding domains
  // by hand never hit it.
  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Add domain' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateDomainDto) {
    return this.svc.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List domains' })
  findAll(@CurrentUser('id') userId: string) {
    return this.svc.findAll(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get domain' })
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.findOne(userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update domain' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() data: { applicationId?: string | null },
  ) {
    return this.svc.update(userId, id, data);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete domain' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }

  @Post(':id/transfer')
  @ApiOperation({ summary: 'Transfer a domain to another project' })
  transfer(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: TransferDomainDto,
  ) {
    return this.svc.transfer(userId, id, dto.targetProjectId);
  }

  @Get(':id/health')
  @ApiOperation({ summary: 'Live DNS health check (A / CNAME / mail flag)' })
  getDnsHealth(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getDnsHealth(userId, id);
  }

  @Get(':id/records')
  @ApiOperation({ summary: 'Full DNS records dump + reconciliation' })
  getDnsRecords(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getDnsRecords(userId, id);
  }
}
