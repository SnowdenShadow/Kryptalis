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
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { FilesService } from './files.service';
import { MkdirDto } from './dto/mkdir.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

type Scope = 'app' | 'db';
function parseScope(scope: string): Scope {
  if (scope !== 'app' && scope !== 'db') throw new BadRequestException('Invalid scope');
  return scope;
}

@ApiTags('Files')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('files')
export class FilesController {
  constructor(private svc: FilesService) {}

  @Get('scopes')
  @ApiOperation({ summary: 'List projects/apps/dbs the user can access' })
  scopes(@CurrentUser('id') userId: string) {
    return this.svc.listScopes(userId);
  }

  @Get('project/:projectId/usage')
  @ApiOperation({ summary: 'Storage usage + quota for a project (bytes)' })
  usage(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.svc.getProjectStorageUsage(userId, projectId);
  }

  @Get(':scope/:scopeId')
  @ApiOperation({ summary: 'List directory contents' })
  list(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Query('path') p?: string,
  ) {
    return this.svc.list(userId, parseScope(scope), scopeId, p || '');
  }

  @Get(':scope/:scopeId/file')
  @ApiOperation({ summary: 'Read a text file' })
  read(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Query('path') p: string,
  ) {
    return this.svc.readFile(userId, parseScope(scope), scopeId, p);
  }

  @Patch(':scope/:scopeId/file')
  @ApiOperation({ summary: 'Write/overwrite a text file' })
  write(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Body() body: { path: string; content: string },
  ) {
    if (typeof body?.path !== 'string') {
      throw new BadRequestException('path required');
    }
    return this.svc.writeFile(userId, parseScope(scope), scopeId, body.path, body.content);
  }

  @Post(':scope/:scopeId/mkdir')
  @ApiOperation({ summary: 'Create a directory' })
  mkdir(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Body() dto: MkdirDto,
  ) {
    return this.svc.mkdir(userId, parseScope(scope), scopeId, dto.path);
  }

  @Patch(':scope/:scopeId/rename')
  @ApiOperation({ summary: 'Rename / move a file or directory' })
  rename(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Body() body: { from: string; to: string },
  ) {
    return this.svc.rename(userId, parseScope(scope), scopeId, body.from, body.to);
  }

  @Delete(':scope/:scopeId/entry')
  @ApiOperation({ summary: 'Delete a file or directory' })
  remove(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Query('path') p: string,
  ) {
    return this.svc.remove(userId, parseScope(scope), scopeId, p);
  }

  @Post(':scope/:scopeId/upload')
  @ApiOperation({ summary: 'Upload a file (raw octet-stream)' })
  async upload(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Query('path') p: string,
    @Query('name') name: string,
    @Req() req: Request,
  ) {
    if (!name) throw new BadRequestException('name query param required');
    const max = 50 * 1024 * 1024;
    // Hard fail on Content-Length too big BEFORE we start reading. Saves
    // bandwidth on obvious abuse and protects against slow-trickle DoS.
    const declared = parseInt(String(req.headers['content-length'] ?? ''), 10);
    if (Number.isFinite(declared) && declared > max) {
      throw new BadRequestException('Upload exceeds 50MB limit');
    }
    // Per-request idle timeout so a half-open stream can't hold a worker
    // forever (slowloris-style).
    try { (req as any).setTimeout?.(60_000); } catch {}
    const chunks: Buffer[] = [];
    let size = 0;
    return new Promise<{ path: string; size: number }>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          req.destroy();
          reject(new BadRequestException('Upload exceeds 50MB limit'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        try {
          const buf = Buffer.concat(chunks);
          const result = await this.svc.uploadFile(userId, parseScope(scope), scopeId, p || '', name, buf);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  @Get(':scope/:scopeId/download')
  @ApiOperation({ summary: 'Download a file' })
  async download(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Query('path') p: string,
    @Res() res: Response,
  ) {
    // Service returns a unified {stream, filename, size} regardless of
    // whether the source is a host-fs O_NOFOLLOW-opened fd or a stream
    // piped from `docker exec cat` inside a container.
    const meta = await this.svc.downloadFile(userId, parseScope(scope), scopeId, p);
    // RFC 5987 encoded filename + ASCII-safe fallback. Prevents
    // Content-Disposition header injection via CRLF or " in the basename.
    const asciiSafe = meta.filename.replace(/[^\x20-\x7e]/g, '_');
    const encoded = encodeURIComponent(meta.filename);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Content-Length', String(meta.size));
    res.setHeader('Content-Type', 'application/octet-stream');
    // Cast to NodeJS.ReadableStream — the service union of {ReadStream
    // | child process stdout} both implement the same Node stream API,
    // but TS can't narrow the union for on/pipe overloads. Cast is safe.
    const stream = meta.stream as NodeJS.ReadableStream;
    stream.on('error', (err: Error) => {
      try { res.destroy(err); } catch {}
    });
    stream.pipe(res);
  }
}
