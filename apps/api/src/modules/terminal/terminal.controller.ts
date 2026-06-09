import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TerminalService } from './terminal.service';
import {
  OpenTerminalDto,
  WriteTerminalDto,
  ResizeTerminalDto,
} from './dto/terminal.dto';

/**
 * REST surface for the Terminal feature.
 *
 *   POST   /terminal             { appId }       → { id, containerName }
 *   POST   /terminal/:id/input   { data }        → { ok: true }
 *   POST   /terminal/:id/resize  { cols, rows }  → { ok: true }
 *   GET    /terminal/:id/output?cursor=N         → { cursor, data, closed }
 *   POST   /terminal/:id/close                   → { ok: true }
 *
 * Long-polling on /output is the only "fancy" part — we never let a
 * single GET sit longer than ~25s (POLL_MAX_WAIT_MS in the service).
 * That keeps reverse-proxy idle limits happy and lets the client keep
 * the cursor in sync.
 */
@ApiTags('Terminal')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('terminal')
export class TerminalController {
  constructor(private svc: TerminalService) {}

  @Post()
  @ApiOperation({ summary: 'Open a shell session against an application container' })
  open(@CurrentUser('id') userId: string, @Body() body: OpenTerminalDto) {
    return this.svc.open(userId, body.appId);
  }

  @Post(':id/input')
  @ApiOperation({ summary: 'Send keystrokes to a shell session' })
  write(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: WriteTerminalDto,
  ) {
    if (typeof body?.data !== 'string') {
      throw new BadRequestException('data must be a string');
    }
    return this.svc.write(userId, id, body.data);
  }

  @Post(':id/resize')
  @ApiOperation({ summary: 'Tell the remote shell the new viewport size' })
  resize(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: ResizeTerminalDto,
  ) {
    return this.svc.resize(userId, id, body.cols, body.rows);
  }

  @Get(':id/output')
  @ApiOperation({ summary: 'Long-poll for stdout/stderr bytes since cursor' })
  read(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = Number(cursor ?? 0);
    return this.svc.read(userId, id, Number.isFinite(n) && n >= 0 ? n : 0);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Tear down a shell session' })
  close(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.close(userId, id);
  }
}
