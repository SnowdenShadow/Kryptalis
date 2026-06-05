import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SslService } from './ssl.service';
import { IssueSslDto } from './dto/issue-ssl.dto';

@ApiTags('SSL')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('ssl')
export class SslController {
  constructor(private svc: SslService) {}

  @Post('issue')
  @ApiOperation({ summary: 'Issue SSL certificate' })
  issue(@Body() dto: IssueSslDto) { return this.svc.issue(dto.domainId); }

  @Post('renew/:id')
  @ApiOperation({ summary: 'Renew SSL certificate' })
  renew(@Param('id') id: string) { return this.svc.renew(id); }

  @Get('certificates')
  @ApiOperation({ summary: 'List certificates' })
  list(@Query('domainId') domainId?: string) { return this.svc.getCertificates(domainId); }
}
