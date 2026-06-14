import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SslService } from './ssl.service';
import { IssueSslDto } from './dto/issue-ssl.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('SSL')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('ssl')
export class SslController {
  constructor(private svc: SslService) {}

  @Post('issue')
  @ApiOperation({ summary: 'Issue SSL certificate (project member only)' })
  issue(@CurrentUser('id') userId: string, @Body() dto: IssueSslDto) {
    return this.svc.issue(userId, dto.domainId);
  }

  @Post('renew/:id')
  @ApiOperation({ summary: 'Renew SSL certificate (project member only)' })
  renew(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.renew(userId, id);
  }

  @Get('certificates')
  @ApiOperation({ summary: 'List certificates scoped to caller projects' })
  list(@CurrentUser('id') userId: string, @Query('domainId') domainId?: string) {
    return this.svc.getCertificates(userId, domainId);
  }

  @Get('diagnose/:domainId')
  @ApiOperation({ summary: 'Explain why a domain’s certificate is/ isn’t issued (DNS / ports / cert)' })
  diagnose(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.svc.diagnose(userId, domainId);
  }

  @Get('logs/:domainId')
  @ApiOperation({ summary: 'Recent Caddy/ACME log lines for a domain (the real issuance error)' })
  logs(
    @CurrentUser('id') userId: string,
    @Param('domainId') domainId: string,
    @Query('lines') lines?: string,
  ) {
    const n = Number(lines);
    return this.svc.getLogs(userId, domainId, Number.isFinite(n) ? n : 200);
  }
}
