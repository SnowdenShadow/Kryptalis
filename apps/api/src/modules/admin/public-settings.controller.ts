import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdminService } from './admin.service';

@ApiTags('Public settings')
@Controller('settings/public')
export class PublicSettingsController {
  constructor(private svc: AdminService) {}

  @Get()
  @ApiOperation({ summary: 'Public-facing settings (used by login/signup pages)' })
  publicSettings() {
    return this.svc.getPublicSettings();
  }
}
