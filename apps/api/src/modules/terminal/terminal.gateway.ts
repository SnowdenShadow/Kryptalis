import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { TerminalService, type TerminalTarget } from './terminal.service';
import * as pty from 'node-pty';
import { Client as SshClient } from 'ssh2';

// Wire protocol (JSON text frames, client→server):
//   { type: 'auth', token: '<jwt>' }        FIRST frame — authenticates the
//                                            session. The token is sent here,
//                                            never in the URL, so it can't leak
//                                            into proxy/access logs or browser
//                                            history. appId stays in the query
//                                            string (it is not a secret).
//   { type: 'data', data: '<utf8>' }         keystrokes
//   { type: 'resize', cols: N, rows: N }     terminal size
// Server→client: raw text frames are terminal output; a final
//   { type: 'exit', code: N } closes the session.

const MAX_SESSIONS_PER_USER = 4;
const IDLE_TIMEOUT_MS = 30 * 60_000; // 30 min of no I/O closes the session
// An unauthenticated socket must not sit idle holding resources — if the first
// 'auth' frame doesn't arrive within this window we drop the connection.
const AUTH_TIMEOUT_MS = 10_000;
// Backpressure: if a noisy process (`yes`, `cat /dev/urandom`) outruns a slow
// client, the ws outbound buffer would grow unbounded → API OOM. Past this we
// PAUSE the source (flow control) and resume once the buffer drains — output is
// deferred, never dropped. Bounds per-session memory to ~this ceiling.
const WS_BUFFER_CEILING = 4 * 1024 * 1024; // 4 MiB

@Injectable()
export class TerminalGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TerminalGateway.name);
  private wss?: WebSocketServer;
  private readonly sessionsByUser = new Map<string, number>();

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
    private terminal: TerminalService,
  ) {}

  /**
   * Attach the WS server to the SAME HTTP server NestJS already listens on, so
   * no extra port is exposed. We do a manual `upgrade` handshake on
   * `/ws/terminal` and reject anything else — other paths (or a future second
   * WS feature) are untouched.
   */
  bind(server: HttpServer) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      let path = '';
      try {
        path = new URL(req.url || '', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (path !== '/ws/terminal') return; // not ours — leave it for others
      this.wss!.handleUpgrade(req, socket as any, head, (ws) => {
        void this.onConnection(ws, req);
      });
    });
    this.logger.log('terminal WS gateway bound on /ws/terminal');
  }

  onModuleInit() {/* bind() is called from main.ts once the HTTP server exists */}
  onModuleDestroy() { this.wss?.close(); }

  private async onConnection(ws: WebSocket, req: IncomingMessage) {
    let userId: string | null = null;
    let target: TerminalTarget | null = null;
    let counted = false; // did we increment this user's session count?
    let closed = false;
    const safeClose = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      try { ws.send(JSON.stringify({ type: 'exit', code, reason })); } catch {}
      try { ws.close(); } catch {}
    };

    // Register the close handler ONCE, up front. It only acts on state that was
    // actually set (counted / target), so a connection rejected before the
    // increment never decrements a slot it didn't take — otherwise rejected
    // attempts could drive the counter negative and defeat the session cap.
    ws.on('close', async () => {
      if (counted && userId) {
        const n = (this.sessionsByUser.get(userId) ?? 1) - 1;
        if (n <= 0) this.sessionsByUser.delete(userId);
        else this.sessionsByUser.set(userId, n);
        await this.audit(userId, '', 'terminal-close').catch(() => {});
      }
      if (target && target.kind === 'remote') await target.cleanup().catch(() => {});
    });

    // appId is NOT a secret, so it may ride the URL; the token must not.
    let appId = '';
    try {
      appId = new URL(req.url || '', 'http://localhost').searchParams.get('appId') || '';
    } catch { /* appId validated below */ }

    // ── Auth handshake: the FIRST frame must be { type:'auth', token }. ──
    // We deliberately do NOT read the token from the URL: query-string tokens
    // leak verbatim into reverse-proxy/access logs, browser history and the
    // DevTools network panel. Until that frame authenticates the socket, the
    // only listener attached is this one, and any non-auth frame is rejected.
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) safeClose(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    ws.once('close', () => clearTimeout(authTimer));

    const authHandler = async (raw: any) => {
      if (authenticated) return; // ignore extra frames during/after handshake
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return safeClose(4001, 'invalid token'); }
      if (msg?.type !== 'auth' || typeof msg.token !== 'string' || !msg.token) {
        return safeClose(4001, 'invalid token');
      }
      authenticated = true;
      clearTimeout(authTimer);
      ws.off('message', authHandler); // hand message handling to the bridge

      try {
        // ── Verify the JWT (same secret/shape as HTTP) BEFORE anything. ──
        let payload: { sub?: string };
        try {
          payload = await this.jwt.verifyAsync(msg.token, {
            secret: this.config.get<string>('JWT_SECRET')!,
          });
        } catch {
          return safeClose(4001, 'invalid token');
        }
        if (!payload?.sub || typeof payload.sub !== 'string') {
          return safeClose(4001, 'invalid token');
        }
        userId = payload.sub;

        // Live user check (banned/suspended lose access immediately).
        const user = await this.prisma.user.findUnique({
          where: { id: userId }, select: { status: true },
        });
        if (!user || user.status !== 'ACTIVE') return safeClose(4003, 'forbidden');

        // ── RBAC: DEVELOPER on the app's project (same bar as write/deploy). ──
        const app = await this.prisma.application.findUnique({
          where: { id: appId }, select: { projectId: true },
        });
        if (!app) return safeClose(4004, 'app not found');
        try {
          await assertProjectAccess(this.prisma, userId, app.projectId, 'DEVELOPER');
        } catch {
          return safeClose(4003, 'forbidden');
        }

        // ── Anti-DoS: cap concurrent sessions per user. ──
        const live = this.sessionsByUser.get(userId) ?? 0;
        if (live >= MAX_SESSIONS_PER_USER) return safeClose(4029, 'too many sessions');
        this.sessionsByUser.set(userId, live + 1);
        counted = true; // from here, the close handler will decrement.

        await this.audit(userId, appId, 'terminal-open');
        target = await this.terminal.resolveTarget(appId, userId);

        if (target.kind === 'local') {
          this.bridgeLocal(ws, target, safeClose);
        } else {
          this.bridgeRemote(ws, target, safeClose);
        }
      } catch (e: any) {
        this.logger.warn(`terminal session error: ${e?.message || e}`);
        safeClose(1011, 'internal error');
      }
    };

    ws.on('message', authHandler);
  }

  // ── LOCAL: docker exec -it into the container via a real PTY (node-pty). ──
  private bridgeLocal(
    ws: WebSocket,
    target: Extract<TerminalTarget, { kind: 'local' }>,
    safeClose: (c: number, r: string) => void,
  ) {
    // argv only — containerName comes from the DB (dockcontrol- prefix), never
    // user input; the login shell line is a fixed string.
    const shell = 'exec $(command -v bash || command -v sh) -l 2>/dev/null || exec sh';
    // `--` terminates docker's flag parsing so a containerName can NEVER be
    // mistaken for a flag (defense-in-depth; the name is DB-sourced + Docker's
    // own naming rule already forbids a leading dash).
    const term = pty.spawn(
      'docker',
      ['exec', '-it', '--', target.containerName, 'sh', '-c', shell],
      { name: 'xterm-256color', cols: 80, rows: 24 },
    );
    let idle = this.armIdle(ws);
    const bp = this.backpressure(ws, () => term.pause(), () => term.resume());
    term.onData((d) => {
      try { ws.send(d); } catch {}
      bp.onOutput();
    });
    term.onExit(({ exitCode }) => safeClose(exitCode ?? 0, 'shell exited'));
    ws.on('message', (raw) => {
      idle = this.kickIdle(ws, idle);
      this.onClientMessage(raw, (d) => term.write(d), (c, r) => term.resize(c, r));
    });
    ws.on('close', () => { clearTimeout(idle); bp.stop(); try { term.kill(); } catch {} });
  }

  // ── REMOTE: SSH-bridge to the agent's :2522 shell channel. ──
  private bridgeRemote(
    ws: WebSocket,
    target: Extract<TerminalTarget, { kind: 'remote' }>,
    safeClose: (c: number, r: string) => void,
  ) {
    const conn = new SshClient();
    let idle = this.armIdle(ws);
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) return safeClose(1011, 'shell open failed');
        const bp = this.backpressure(ws, () => stream.pause(), () => stream.resume());
        const onOut = (d: Buffer) => {
          try { ws.send(d.toString('utf8')); } catch {}
          bp.onOutput();
        };
        stream.on('data', onOut);
        stream.stderr.on('data', onOut);
        stream.on('close', () => safeClose(0, 'shell exited'));
        ws.on('message', (raw) => {
          idle = this.kickIdle(ws, idle);
          this.onClientMessage(raw, (d) => stream.write(d), (c, r) => stream.setWindow(r, c, 0, 0));
        });
        ws.on('close', () => { clearTimeout(idle); bp.stop(); try { stream.end(); conn.end(); } catch {} });
      });
    });
    conn.on('error', (e) => safeClose(1011, `ssh: ${e.message}`));
    conn.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: 15_000,
      // Pin nothing extra — the agent host key is TOFU here; the link rides the
      // same trusted network as every other agent task (poll/deploy).
      algorithms: undefined,
    });
  }

  /** Parse one client frame into a data-write or a resize. Ignores garbage. */
  private onClientMessage(
    raw: any,
    onData: (d: string) => void,
    onResize: (cols: number, rows: number) => void,
  ) {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === 'data' && typeof msg.data === 'string') onData(msg.data);
    else if (msg?.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      const cols = Math.min(500, Math.max(1, msg.cols));
      const rows = Math.min(300, Math.max(1, msg.rows));
      onResize(cols, rows);
    }
  }

  private armIdle(ws: WebSocket): NodeJS.Timeout {
    return setTimeout(() => { try { ws.close(4008, 'idle timeout'); } catch {} }, IDLE_TIMEOUT_MS);
  }
  private kickIdle(ws: WebSocket, t: NodeJS.Timeout): NodeJS.Timeout {
    clearTimeout(t);
    return this.armIdle(ws);
  }

  /**
   * Flow control: pause the source when the ws send buffer is congested
   * (`bufferedAmount` > ceiling), resume once it drains. The CRITICAL part is
   * the resume — pausing the source stops its 'data' events, so the resume
   * check can't live in the data handler (it would never fire again →
   * permanent freeze). We drive it from an independent interval that runs ONLY
   * while paused, then stops. `onOutput()` is called on each data tick to
   * (re)evaluate the pause condition; `stop()` clears the timer on ws close.
   */
  private backpressure(ws: WebSocket, pause: () => void, resume: () => void) {
    let paused = false;
    let timer: NodeJS.Timeout | null = null;
    const clear = () => { if (timer) { clearInterval(timer); timer = null; } };
    return {
      onOutput: () => {
        if (!paused && ws.bufferedAmount > WS_BUFFER_CEILING) {
          paused = true;
          try { pause(); } catch {}
          // Independent drain poller — the source is paused so no data tick
          // will re-check; this is the only thing that can resume it.
          timer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) { clear(); return; }
            if (ws.bufferedAmount < WS_BUFFER_CEILING / 2) {
              paused = false;
              clear();
              try { resume(); } catch {}
            }
          }, 200);
        }
      },
      stop: clear,
    };
  }

  private async audit(userId: string, appId: string, action: string) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId,
          action,
          resource: appId ? `application:${appId}` : 'terminal',
          resourceId: appId || null,
        },
      });
    } catch {/* audit is best-effort */}
  }
}
