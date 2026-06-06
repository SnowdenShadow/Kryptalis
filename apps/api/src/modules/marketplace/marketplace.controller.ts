import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MarketplaceService } from './marketplace.service';
import { InstallAppDto } from './dto/install-app.dto';
import { InstallCustomDto } from './dto/install-custom.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Marketplace')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('marketplace')
export class MarketplaceController {
  constructor(private svc: MarketplaceService) {}

  @Get()
  @ApiOperation({ summary: 'List marketplace apps' })
  list() { return this.svc.listApps(); }

  @Get(':slug')
  @ApiOperation({ summary: 'Get app details' })
  get(@Param('slug') slug: string) { return this.svc.getApp(slug); }

  @Post('install')
  @ApiOperation({ summary: 'Install app' })
  install(@CurrentUser('id') userId: string, @Body() dto: InstallAppDto) {
    return this.svc.install(dto, userId);
  }

  // Open-marketplace endpoint — deploy any Docker Hub image without a template.
  @Post('install-custom')
  @ApiOperation({ summary: 'Deploy any Docker image (no template required)' })
  installCustom(@CurrentUser('id') userId: string, @Body() dto: InstallCustomDto) {
    return this.svc.installCustom(dto, userId);
  }
}
