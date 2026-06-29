import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectTransferService } from './project-transfer.service';
import { ExportProjectDto } from './dto/export-project.dto';
import { ApplyImportDto } from './dto/apply-import.dto';

/**
 * Cross-install project transfer endpoints.
 *
 *   POST /api/projects/:id/export          → build encrypted .dctproj, returns a token
 *   GET  /api/projects/transfer/download/* → stream the .dctproj (one-shot)
 *   POST /api/projects/transfer/parse       → upload .dctproj (raw stream) + passphrase → review
 *   POST /api/projects/transfer/apply       → recreate the project on THIS install
 */
@ApiTags('project-transfer')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller()
export class ProjectTransferController {
  // In-memory one-shot download tokens → archive path. Cleared after download.
  private downloads = new Map<string, { path: string; filename: string; userId: string }>();

  constructor(private readonly svc: ProjectTransferService) {}

  private token(): string {
    return `dl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  }

  @Post('projects/:id/export')
  @ApiOperation({ summary: 'Export a project to an encrypted .dctproj (OWNER only)' })
  async export(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ExportProjectDto,
  ) {
    const { archivePath, filename } = await this.svc.exportProject(userId, id, {
      includeData: !!dto.includeData,
      includeImages: !!dto.includeImages,
      passphrase: dto.passphrase,
    });
    const tok = this.token();
    this.downloads.set(tok, { path: archivePath, filename, userId });
    return { downloadToken: tok, filename };
  }

  @Get('projects/transfer/download/:token')
  @ApiOperation({ summary: 'Stream a prepared .dctproj once, then delete it' })
  async download(
    @CurrentUser('id') userId: string,
    @Param('token') tok: string,
    @Res() res: Response,
  ) {
    const entry = this.downloads.get(tok);
    if (!entry || entry.userId !== userId) {
      throw new BadRequestException('Download not found or expired.');
    }
    this.downloads.delete(tok);
    if (!fs.existsSync(entry.path)) throw new BadRequestException('Archive expired — re-export.');
    const stat = fs.statSync(entry.path);
    // Quote-escape the filename to prevent header injection via the name.
    const safe = entry.filename.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    const stream = fs.createReadStream(entry.path);
    stream.on('close', () => { fs.promises.unlink(entry.path).catch(() => undefined); });
    stream.pipe(res);
  }

  @Post('projects/transfer/parse')
  @ApiOperation({ summary: 'Upload a .dctproj (raw octet-stream) + passphrase → review' })
  async parse(
    @CurrentUser('id') userId: string,
    @Query('passphrase') passphrase: string,
    @Req() req: Request,
  ) {
    if (!passphrase) throw new BadRequestException('passphrase query param required');
    const os = await import('os');
    const path = await import('path');
    const crypto = await import('crypto');
    const tmp = path.join(os.tmpdir(), `dctproj-upload-${crypto.randomBytes(8).toString('hex')}.dctproj`);
    // This endpoint bypasses the global body parser (the body is a raw
    // encrypted .dctproj stream), so it has no size limit of its own. Enforce
    // one here as we stream to disk, or a client could send an unbounded body
    // and exhaust the host's temp disk before parseImport ever runs.
    const MAX_DCTPROJ_BYTES = 512 * 1024 * 1024; // 512 MiB
    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
        let settled = false;
        let received = 0;
        const fail = (e: unknown) => { if (settled) return; settled = true; try { out.destroy(); } catch {} reject(e); };
        req.on('error', fail);
        out.on('error', fail);
        req.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_DCTPROJ_BYTES) {
            fail(new BadRequestException('Upload exceeds the 512 MiB project-archive limit.'));
            try { req.destroy(); } catch {}
          }
        });
        out.on('finish', () => { if (!settled) { settled = true; resolve(); } });
        req.pipe(out);
      });
      return await this.svc.parseImport(userId, tmp, passphrase);
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }
  }

  @Post('projects/transfer/apply')
  @ApiOperation({ summary: 'Apply a parsed import — recreate the project on this install' })
  async apply(@CurrentUser('id') userId: string, @Body() dto: ApplyImportDto) {
    return this.svc.applyImport(userId, dto.stagedId, {
      passphrase: dto.passphrase,
      targetServerId: dto.targetServerId,
      domainStrategy: dto.domainStrategy,
      allowHostAccess: dto.allowHostAccess,
      gitProviderMap: dto.gitProviderMap,
    });
  }
}
