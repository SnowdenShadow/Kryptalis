import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnModuleDestroy,
} from '@nestjs/common';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';

/**
 * Interactive shell sessions backed by `docker exec`. Lets a project
 * ADMIN attach a browser-side terminal to one of their app containers
 * (and the platform-managed SFTP container, for the rare case where
 * they want to inspect chroot state). Implementation deliberately
 * skips websockets: we long-poll a ring buffer of stdout chunks,
 * which is simpler, friendlier to reverse proxies, and good enough at
 * keystroke latency over LAN-class links.
 *
 * Architecture:
 *
 *   POST /terminal/open        →  spawn `docker exec -it <ctn> /bin/sh`
 *                                 stash the child process in a Map,
 *                                 keyed by an opaque sessionId
 *   POST /terminal/:id/input   →  write to child.stdin
 *   GET  /terminal/:id/output  →  return buffered stdout/stderr since
 *                                 the last cursor; long-polls up to 25s
 *                                 if the buffer is empty
 *   POST /terminal/:id/close   →  SIGTERM → SIGKILL the child
 *
 * Safety:
 *   - Per-session 30min idle timeout (handler resets on every input/
 *     output).
 *   - Hard 4-hour wall-clock cap regardless of activity.
 *   - Max 1024 KiB stdout buffered per session; oldest bytes drop on
 *     overflow so a runaway `cat` can't OOM the API.
 *   - Container target must belong to an app the user can ADMIN.
 *   - Shell is decided by us (`/bin/sh` with `/bin/bash` upgrade if
 *     available) — caller never picks the binary.
 *   - We `docker exec -i` (NOT -it on the host side; the PTY is
 *     emulated by xterm in the browser via output bytes). That keeps
 *     `process.stdin.isTTY` false inside the container, which the
 *     image's tools cope with (less, vim, htop will degrade
 *     gracefully).
 */

interface Session {
  id: string;
  userId: string;
  containerName: string;
  child: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  // Monotonic cursor: every byte we ever emit increments this. The
  // client polls /output?cursor=N and gets `buffer.slice(N-startOffset)`.
  // We track startOffset so a buffer truncation (cap exceeded) doesn't
  // confuse the cursor.
  totalEmitted: number;
  startOffset: number;
  pollers: Array<{ resolve: (data: { cursor: number; data: string; closed: boolean }) => void; cursor: number; timer: NodeJS.Timeout }>;
  closed: boolean;
  closedReason?: string;
  createdAt: number;
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout;
  maxAgeTimer: NodeJS.Timeout;
}

@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalService.name);
  private sessions = new Map<string, Session>();

  private static readonly MAX_BUFFER_BYTES = 1024 * 1024;
  private static readonly IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;
  private static readonly POLL_MAX_WAIT_MS = 25_000;
  // Container names follow the deploy naming convention.
  private static readonly CONTAINER_NAME_RE = /^[a-z0-9_-]{1,64}$/;

  constructor(private prisma: PrismaService) {}

  onModuleDestroy(): void {
    for (const s of this.sessions.values()) {
      this.killSession(s, 'api shutdown');
    }
    this.sessions.clear();
  }

  // ── Public API ────────────────────────────────────────────────────

  async open(
    userId: string,
    appId: string,
  ): Promise<{ id: string; containerName: string }> {
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
      select: { id: true, projectId: true, containerName: true, name: true },
    });
    if (!app) throw new NotFoundException('Application not found');
    await assertProjectAccess(this.prisma, userId, app.projectId, 'ADMIN');
    if (!app.containerName) {
      throw new BadRequestException('Application is not currently running — terminal needs a live container');
    }
    if (!TerminalService.CONTAINER_NAME_RE.test(app.containerName)) {
      // Refuse anything that doesn't match our naming convention; we
      // pass the value as an argv to `docker exec`, and even though
      // execFile/spawn skip the shell, we want a single, tight
      // validation surface.
      throw new BadRequestException('Container name violates naming policy');
    }

    const id = crypto.randomBytes(16).toString('hex');
    const child = this.spawnDockerExec(app.containerName);

    const session: Session = {
      id,
      userId,
      containerName: app.containerName,
      child,
      buffer: Buffer.alloc(0),
      totalEmitted: 0,
      startOffset: 0,
      pollers: [],
      closed: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null as unknown as NodeJS.Timeout,
      maxAgeTimer: null as unknown as NodeJS.Timeout,
    };

    // Idle + max-age timers. `unref` so they never keep the process
    // alive on graceful shutdown.
    session.idleTimer = setTimeout(
      () => this.killSession(session, 'idle timeout'),
      TerminalService.IDLE_TIMEOUT_MS,
    );
    session.idleTimer.unref?.();
    session.maxAgeTimer = setTimeout(
      () => this.killSession(session, 'max lifetime exceeded'),
      TerminalService.MAX_LIFETIME_MS,
    );
    session.maxAgeTimer.unref?.();

    const onChunk = (data: Buffer) => this.appendBuffer(session, data);
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code, signal) => {
      session.closed = true;
      session.closedReason = `exit code=${code} signal=${signal}`;
      this.flushPollers(session);
    });
    child.on('error', (err) => {
      session.closed = true;
      session.closedReason = `spawn error: ${err.message}`;
      this.flushPollers(session);
    });

    this.sessions.set(id, session);
    this.logger.log(`Terminal opened: ${id} → ${app.containerName} (user=${userId})`);
    return { id, containerName: app.containerName };
  }

  async write(userId: string, id: string, data: string): Promise<{ ok: true }> {
    const s = this.requireOwnedSession(userId, id);
    if (s.closed) throw new BadRequestException('Session closed');
    this.touch(s);
    try {
      s.child.stdin.write(data);
    } catch (err: any) {
      throw new BadRequestException(`Write failed: ${err?.message || err}`);
    }
    return { ok: true };
  }

  async resize(userId: string, id: string, cols: number, rows: number): Promise<{ ok: true }> {
    const s = this.requireOwnedSession(userId, id);
    if (s.closed) throw new BadRequestException('Session closed');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000) {
      throw new BadRequestException('Invalid cols/rows');
    }
    // We don't have a real PTY (docker exec without -t). The TIOCSWINSZ
    // ioctl wouldn't apply anyway. We instead send the COLUMNS/LINES
    // env update via `stty cols X rows Y` if the remote shell has stty.
    // Best-effort — many minimal containers don't ship stty.
    try {
      s.child.stdin.write(`stty cols ${cols} rows ${rows} 2>/dev/null\n`);
    } catch {}
    return { ok: true };
  }

  /**
   * Long-polled output read. Holds the request until either new bytes
   * arrive or the poll timeout elapses (whichever first). The cursor
   * lets the client resume cleanly after a network blip.
   */
  async read(
    userId: string,
    id: string,
    cursor: number,
  ): Promise<{ cursor: number; data: string; closed: boolean; closedReason?: string }> {
    const s = this.requireOwnedSession(userId, id);
    this.touch(s);
    const available = this.sliceFromCursor(s, cursor);
    if (available.data.length > 0 || s.closed) {
      return {
        cursor: available.cursor,
        data: available.data,
        closed: s.closed,
        closedReason: s.closedReason,
      };
    }
    // No data ready and the session is alive — long-poll.
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Time out → return whatever's there (empty most likely).
        const slice = this.sliceFromCursor(s, cursor);
        s.pollers = s.pollers.filter((p) => p.resolve !== entry.resolve);
        resolve({
          cursor: slice.cursor,
          data: slice.data,
          closed: s.closed,
          closedReason: s.closedReason,
        });
      }, TerminalService.POLL_MAX_WAIT_MS);
      timer.unref?.();
      const entry = {
        resolve: (out: { cursor: number; data: string; closed: boolean }) => {
          clearTimeout(timer);
          resolve(out);
        },
        cursor,
        timer,
      };
      s.pollers.push(entry);
    });
  }

  async close(userId: string, id: string): Promise<{ ok: true }> {
    const s = this.requireOwnedSession(userId, id);
    this.killSession(s, 'user closed');
    return { ok: true };
  }

  // ── Internals ─────────────────────────────────────────────────────

  private spawnDockerExec(containerName: string): ChildProcessWithoutNullStreams {
    // We probe for bash and fall back to sh. Done via `sh -c '...'` so
    // the launched command is a single string the docker daemon
    // forwards verbatim. Arg interpolation is safe because
    // containerName is regex-validated upstream.
    const cmd = '[ -x /bin/bash ] && exec /bin/bash || exec /bin/sh';
    return spawn('docker', ['exec', '-i', containerName, 'sh', '-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Don't leak parent env into the docker exec child. The shell
      // inside the container has its own env via the container's
      // image/runtime config.
      env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
  }

  private touch(s: Session) {
    s.lastActivityAt = Date.now();
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(
      () => this.killSession(s, 'idle timeout'),
      TerminalService.IDLE_TIMEOUT_MS,
    );
    s.idleTimer.unref?.();
  }

  private appendBuffer(s: Session, data: Buffer) {
    s.buffer = Buffer.concat([s.buffer, data]);
    s.totalEmitted += data.length;
    if (s.buffer.length > TerminalService.MAX_BUFFER_BYTES) {
      const drop = s.buffer.length - TerminalService.MAX_BUFFER_BYTES;
      s.buffer = s.buffer.subarray(drop);
      s.startOffset += drop;
    }
    this.flushPollers(s);
  }

  private flushPollers(s: Session) {
    for (const p of s.pollers) {
      const slice = this.sliceFromCursor(s, p.cursor);
      if (slice.data.length > 0 || s.closed) {
        clearTimeout(p.timer);
        p.resolve({
          cursor: slice.cursor,
          data: slice.data,
          closed: s.closed,
        });
      }
    }
    s.pollers = s.pollers.filter((p) => {
      const slice = this.sliceFromCursor(s, p.cursor);
      return slice.data.length === 0 && !s.closed;
    });
  }

  /**
   * Pull every byte the session has emitted since `cursor`. If cursor
   * is behind the buffer's startOffset (oldest bytes already dropped
   * due to overflow), we emit from startOffset and return that as the
   * new cursor — the client gets a hint that some bytes were lost.
   */
  private sliceFromCursor(s: Session, cursor: number): { cursor: number; data: string } {
    if (cursor >= s.totalEmitted) {
      return { cursor: s.totalEmitted, data: '' };
    }
    const fromIdx = Math.max(0, cursor - s.startOffset);
    const chunk = s.buffer.subarray(fromIdx);
    return { cursor: s.totalEmitted, data: chunk.toString('utf-8') };
  }

  private requireOwnedSession(userId: string, id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException('Terminal session not found');
    if (s.userId !== userId) {
      throw new ForbiddenException('Session belongs to another user');
    }
    return s;
  }

  private killSession(s: Session, reason: string) {
    if (s.closed) return;
    s.closed = true;
    s.closedReason = reason;
    clearTimeout(s.idleTimer);
    clearTimeout(s.maxAgeTimer);
    try {
      s.child.stdin.end();
    } catch {}
    try {
      s.child.kill('SIGTERM');
    } catch {}
    // SIGKILL after 2s if SIGTERM doesn't stick (rare for `sh`).
    const killTimer = setTimeout(() => {
      try { s.child.kill('SIGKILL'); } catch {}
    }, 2000);
    killTimer.unref?.();
    this.flushPollers(s);
    // Defer the Map cleanup so an in-flight client poll still gets the
    // `closed` event back. Anything trying to write to a closed session
    // is rejected at the controller level via the `closed` flag.
    setTimeout(() => this.sessions.delete(s.id), 5_000).unref?.();
    this.logger.log(`Terminal ${s.id} closed: ${reason}`);
  }
}
