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
import * as fs from 'fs';
import { FilesService } from './files.service';
import { MkdirDto } from './dto/mkdir.dto';
import { ExtractZipDto } from './dto/extract-zip.dto';
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

  @Post(':scope/:scopeId/extract')
  @ApiOperation({ summary: 'Extract a .zip archive in place' })
  extract(
    @CurrentUser('id') userId: string,
    @Param('scope') scope: string,
    @Param('scopeId') scopeId: string,
    @Body() dto: ExtractZipDto,
  ) {
    return this.svc.extract(userId, parseScope(scope), scopeId, dto.path, {
      deleteAfter: dto.deleteAfter,
    });
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
    // Stream the body to a temp file on disk — the full payload is
    // NEVER held in memory. A running byte counter aborts the request
    // as soon as the 50MB cap is crossed; the service then checks quota
    // against the temp file's on-disk size before moving it into place.
    const tempPath = this.svc.createUploadTempPath();
    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
        let size = 0;
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          try { out.destroy(); } catch {}
          reject(err);
        };
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            req.destroy();
            fail(new BadRequestException('Upload exceeds 50MB limit'));
          }
        });
        req.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        req.pipe(out);
      });
      return await this.svc.uploadFile(userId, parseScope(scope), scopeId, p || '', name, tempPath);
    } finally {
      // Best-effort cleanup — on the local success path the temp was
      // already rename()d away and unlink is a harmless ENOENT.
      await fs.promises.unlink(tempPath).catch(() => {});
    }
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
