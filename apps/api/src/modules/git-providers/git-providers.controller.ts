import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { GitProvidersService } from './git-providers.service';
import { GitOAuthService } from './git-oauth.service';
import { CreateGitProviderDto } from './dto/create-git-provider.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Git Providers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('git-providers')
export class GitProvidersController {
  constructor(
    private svc: GitProvidersService,
    private oauth: GitOAuthService,
  ) {}

  // ── OAuth Device Flow ───────────────────────────────────────────────

  @Get('oauth/github/status')
  @ApiOperation({ summary: 'Whether GitHub OAuth is configured on this install' })
  oauthStatus() {
    return { configured: this.oauth.isConfigured('GITHUB') };
  }

  @Post('oauth/github/device/start')
  @ApiOperation({ summary: 'Start GitHub device-flow → returns the user_code to display' })
  startDevice() {
    return this.oauth.startGithubDeviceFlow();
  }

  @Post('oauth/github/device/poll')
  @ApiOperation({ summary: 'Poll GitHub for the access token — call repeatedly until state=authorized' })
  pollDevice(
    @CurrentUser('id') userId: string,
    @Body('deviceCode') deviceCode: string,
  ) {
    return this.oauth.pollGithubDeviceFlow(userId, deviceCode);
  }

  @Post()
  @ApiOperation({ summary: 'Connect a git provider' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateGitProviderDto) {
    return this.svc.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List connected git providers' })
  findAll(@CurrentUser('id') userId: string) {
    return this.svc.findAll(userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Disconnect a git provider' })
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.svc.remove(id, userId);
  }

  @Get(':id/repos')
  @ApiOperation({ summary: 'List repositories from a git provider' })
  listRepos(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.svc.listRepos(id, userId);
  }

  @Get(':id/detect')
  @ApiOperation({ summary: 'Detect framework and config from a repo' })
  detectRepo(
    @Param('id') id: string,
    @Query('repo') repo: string,
    @Query('branch') branch: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.svc.detectRepo(id, userId, repo, branch);
  }

  @Get(':id/file')
  @ApiOperation({ summary: 'Fetch raw content of a file from a repo (compose/Dockerfile preview)' })
  getFile(
    @Param('id') id: string,
    @Query('repo') repo: string,
    @Query('branch') branch: string,
    @Query('path') filePath: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.svc.fetchFile(id, userId, repo, branch, filePath);
  }
}
