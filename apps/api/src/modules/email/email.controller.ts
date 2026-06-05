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

  @Delete('server/:domainId')
  @ApiOperation({ summary: 'Remove the mail server (containers + data)' })
  removeMailServer(@CurrentUser('id') userId: string, @Param('domainId') domainId: string) {
    return this.mailServer.remove(userId, domainId);
  }
}
