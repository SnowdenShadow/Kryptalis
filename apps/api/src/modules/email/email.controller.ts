import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { EmailService } from './email.service';
import { MailServerService } from './mail-server.service';
import { CreateMailboxDto } from './dto/create-mailbox.dto';
import { UpdateMailboxDto } from './dto/update-mailbox.dto';
import { CreateAliasDto } from './dto/create-alias.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Email')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('email')
export class EmailController {
  constructor(
    private svc: EmailService,
    private mailServer: MailServerService,
  ) {}

  // mailboxes
  @Post('mailboxes')
  @ApiOperation({ summary: 'Create a mailbox' })
  createMailbox(@CurrentUser('id') userId: string, @Body() dto: CreateMailboxDto) {
    return this.svc.createMailbox(userId, dto);
  }

  @Get('mailboxes')
  @ApiOperation({ summary: 'List mailboxes' })
  listMailboxes(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
    @Query('domainId') domainId?: string,
  ) {
    return this.svc.listMailboxes(userId, { projectId, domainId });
  }

  @Get('mailboxes/:id')
  @ApiOperation({ summary: 'Get a mailbox' })
  getMailbox(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getMailbox(userId, id);
  }

  @Patch('mailboxes/:id')
  @ApiOperation({ summary: 'Update a mailbox' })
  updateMailbox(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMailboxDto,
  ) {
    return this.svc.updateMailbox(userId, id, dto);
  }

  @Delete('mailboxes/:id')
  @ApiOperation({ summary: 'Delete a mailbox' })
  removeMailbox(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.removeMailbox(userId, id);
  }

  // aliases
  @Post('aliases')
  @ApiOperation({ summary: 'Create an alias / forwarder' })
  createAlias(@CurrentUser('id') userId: string, @Body() dto: CreateAliasDto) {
    return this.svc.createAlias(userId, dto);
  }

  @Get('aliases')
  @ApiOperation({ summary: 'List aliases for a domain' })
  listAliases(
    @CurrentUser('id') userId: string,
    @Query('domainId') domainId: string,
  ) {
    return this.svc.listAliases(userId, domainId);
  }

  @Delete('aliases/:id')
  @ApiOperation({ summary: 'Delete an alias' })
  removeAlias(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.removeAlias(userId, id);
  }

  // overview — list every mail-eligible domain with its mail server status
  // and mailbox/alias counts. Drives /dashboard/emails.
  @Get('overview')
  @ApiOperation({ summary: 'Cross-domain email overview for the dashboard' })
  overview(@CurrentUser('id') userId: string) {
    return this.svc.overview(userId);
  }

  // dns
  @Get('dns/:domainId')
  @ApiOperation({ summary: 'DNS records hints for email hosting' })
  getDnsHints(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.svc.getDnsHints(userId, domainId);
  }

  // dns health — live probe of public DNS to tell the operator exactly
  // which records are missing, wrong, or partially propagated.
  @Get('dns/:domainId/health')
  @ApiOperation({ summary: 'Live DNS health check (MX/A/PTR/SPF/DKIM/DMARC)' })
  getDnsHealth(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.svc.getDnsHealth(userId, domainId);
  }

  // mail server lifecycle
  @Get('server/:domainId')
  @ApiOperation({ summary: 'Status of the mail server for a domain' })
  getMailServer(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.mailServer.getStatus(userId, domainId);
  }

  @Post('server/:domainId/deploy')
  @ApiOperation({ summary: 'Deploy or redeploy the mail server (Postfix+Dovecot+rspamd)' })
  deployMailServer(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.mailServer.deploy(userId, domainId);
  }

  @Post('server/:domainId/stop')
  @ApiOperation({ summary: 'Stop the mail server' })
  stopMailServer(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.mailServer.stop(userId, domainId);
  }

  @Post('server/:domainId/webmail')
  @ApiOperation({ summary: 'Install (1-click) a Roundcube webmail preconfigured for this domain' })
  deployWebmail(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.mailServer.deployWebmail(userId, domainId);
  }

  @Delete('server/:domainId')
  @ApiOperation({ summary: 'Remove the mail server (containers + data)' })
  removeMailServer(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.mailServer.remove(userId, domainId);
  }

  @Post('server/:domainId/test')
  @ApiOperation({ summary: 'Send a test email from a mailbox to any address' })
  sendTestEmail(
    @CurrentUser('id') userId: string,
    @Param('domainId') domainId: string,
    @Body() body: { fromMailboxId: string; to: string },
  ) {
    return this.mailServer.sendTestEmail(userId, domainId, body.fromMailboxId, body.to);
  }

  @Get('server/:domainId/logs')
  @ApiOperation({ summary: 'Tail Postfix/Dovecot/rspamd/fail2ban logs' })
  getMailLogs(
    @CurrentUser('id') userId: string,
    @Param('domainId') domainId: string,
    @Query('lines') lines?: string,
    @Query('service') service?: string,
  ) {
    return this.mailServer.getLogs(userId, domainId, {
      lines: lines ? parseInt(lines, 10) : 200,
      service: (service as any) || 'all',
    });
  }

  @Get('server/:domainId/bans')
  @ApiOperation({ summary: 'List currently banned IPs (fail2ban)' })
  getBans(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.mailServer.getBans(userId, domainId);
  }

  @Post('server/:domainId/unban')
  @ApiOperation({ summary: 'Unban an IP in the mail server fail2ban jails' })
  unban(
    @CurrentUser('id') userId: string,
    @Param('domainId') domainId: string,
    @Body() body: { ip: string },
  ) {
    return this.mailServer.unbanIp(userId, domainId, body.ip);
  }
}
