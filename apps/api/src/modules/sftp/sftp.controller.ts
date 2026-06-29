import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseEnumPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SftpService } from './sftp.service';
import {
  CreateSftpAccountDto,
  UpdateSftpAccountDto,
} from './dto/sftp.dto';

@ApiTags('SFTP')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('sftp')
export class SftpController {
  constructor(private svc: SftpService) {}

  @Get()
  @ApiOperation({ summary: 'List SFTP accounts for an app or project' })
  list(
    @CurrentUser('id') userId: string,
    // Validate the enum at runtime (TS types are erased) so an unexpected
    // ?scope=foo yields a clean 400 instead of silently falling through the
    // service's `scope === 'project'` branch as if it were 'app'.
    @Query('scope', new ParseEnumPipe(['app', 'project'])) scope: 'app' | 'project',
    @Query('scopeId') scopeId: string,
  ) {
    return this.svc.list(userId, scope, scopeId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new SFTP account' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() body: CreateSftpAccountDto,
  ) {
    const { account, plainPassword } = await this.svc.create(
      userId,
      body.scope,
      body.scopeId,
      {
        username: body.username,
        password: body.password,
        publicKeys: body.publicKeys,
        permission: body.permission,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        allowShell: body.allowShell,
      },
    );
    // We return the plaintext password ONCE on creation so the user
    // can copy it into Filezilla. Subsequent fetches never expose it
    // (DB stores bcrypt only).
    return { ...account, plainPassword };
  }

  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the password — returns the new plaintext once' })
  rotate(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.rotatePassword(userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an SFTP account (toggle disable, permission, keys, expiry)' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: UpdateSftpAccountDto,
  ) {
    return this.svc.update(userId, id, {
      disabled: body.disabled,
      permission: body.permission,
      expiresAt: body.expiresAt === null ? null : body.expiresAt ? new Date(body.expiresAt) : undefined,
      publicKeys: body.publicKeys,
      allowShell: body.allowShell,
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an SFTP account' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }
}
