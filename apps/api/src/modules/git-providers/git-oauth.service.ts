import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';

type Provider = 'GITHUB';

/**
 * GitHub OAuth via Device Flow.
 *
 * Why device flow instead of Web flow:
 *   - No client secret → safe to bake the client_id into the codebase.
 *     Every DockControl install can use the same app without any operator
 *     setup. `install.sh` users get OAuth for free.
 *   - No callback URL → works on localhost, raw IP, custom domain, behind
 *     NAT, on someone's homelab. The Web flow falls over the second the
 *     install isn't on the URL the OAuth App was registered with.
 *   - It's exactly what `gh CLI`, `docker login`, and dozens of
 *     terminal/embedded apps use for the same reasons.
 *
 * Flow:
 *   1. POST https://github.com/login/device/code → { user_code,
 *      device_code, verification_uri, interval, expires_in }
 *   2. Dashboard shows `user_code` and a "Open github.com/login/device"
 *      button. User pastes the code, authorizes the app.
 *   3. While the user is doing that, the dashboard polls
 *      POST /git-providers/oauth/github/poll → which itself polls
 *      https://github.com/login/oauth/access_token until the user finishes.
 *   4. On success we get an access_token, upsert a GitProvider row in
 *      OAUTH mode, return success.
 *
 * Public client_id:
 *   The GitHub-issued client_id IS public — see GitHub's own docs. It's
 *   just an identifier, not a credential. The credential equivalent (the
 *   client secret) is NOT used in device flow at all, so committing the
 *   client_id is safe.
 *
 *   The baked-in default is the official DockControl OAuth App ("DockControl"
 *   on github.com, Device Flow enabled). Operators who want their own
 *   branding/app can override it with GITHUB_OAUTH_CLIENT_ID in env.
 */
const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Ov23liGhrCZJ2hB4ILtX';
@Injectable()
export class GitOAuthService {
  private readonly logger = new Logger(GitOAuthService.name);

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  isConfigured(provider: Provider): boolean {
    if (provider === 'GITHUB') return !!this.githubClientId();
    return false;
  }

  private githubClientId(): string {
    return process.env.GITHUB_OAUTH_CLIENT_ID || DEFAULT_GITHUB_OAUTH_CLIENT_ID;
  }

  /**
   * Step 1 — ask GitHub for a device code. The dashboard shows the
   * user_code and opens verification_uri.
   *
   * GitHub returns `verification_uri_complete` (with the code prefilled
   * in the URL) for newer apps. We return that too so the dashboard
   * can render a single button that does everything in one click.
   */
  async startGithubDeviceFlow(): Promise<{
    userCode: string;
    deviceCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
    interval: number;
  }> {
    const clientId = this.githubClientId();
    if (!clientId) {
      throw new BadRequestException('GitHub OAuth is not configured — set GITHUB_OAUTH_CLIENT_ID');
    }
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        // `repo` covers private repos + webhook ops on repos the user
        // owns. `read:user` identifies them. Adding scopes later requires
        // the user to re-authorize — keep this list tight from day one.
        scope: 'repo read:user user:email',
      }),
    });
    const data: any = await res.json();
    if (!res.ok || !data.device_code) {
      throw new BadRequestException(data.error_description || data.error || 'GitHub device code request failed');
    }
    return {
      userCode: data.user_code,
      deviceCode: data.device_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresIn: data.expires_in,
      interval: Math.max(5, data.interval || 5), // floor at 5s; GitHub will rate-limit aggressive polling
    };
  }

  /**
   * Step 3 — poll GitHub for the access token. Called repeatedly by the
   * dashboard until either:
   *   - GitHub returns the access_token (user approved) → we save it and
   *     return { state: 'authorized' }.
   *   - GitHub returns `authorization_pending` → tell the dashboard to
   *     keep polling.
   *   - GitHub returns `slow_down` → the dashboard should increase its
   *     poll interval.
   *   - GitHub returns `expired_token` / `access_denied` → terminal.
   */
  async pollGithubDeviceFlow(userId: string, deviceCode: string): Promise<{
    state: 'authorized' | 'pending' | 'slow_down' | 'expired' | 'denied' | 'error';
    message?: string;
  }> {
    if (!deviceCode || typeof deviceCode !== 'string') {
      throw new BadRequestException('device_code is required');
    }
    const clientId = this.githubClientId();
    if (!clientId) {
      throw new BadRequestException('GitHub OAuth is not configured — set GITHUB_OAUTH_CLIENT_ID');
    }
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data: any = await res.json();
    if (data.error) {
      switch (data.error) {
        case 'authorization_pending':
          return { state: 'pending' };
        case 'slow_down':
          return { state: 'slow_down' };
        case 'expired_token':
          return { state: 'expired', message: 'The code expired. Start again.' };
        case 'access_denied':
          return { state: 'denied', message: 'You denied authorization.' };
        default:
          return { state: 'error', message: data.error_description || data.error };
      }
    }
    if (!data.access_token) {
      return { state: 'error', message: 'Token response missing access_token' };
    }

    const userInfo = await this.fetchGithubUser(data.access_token);
    if (!userInfo) {
      throw new BadRequestException('Could not fetch GitHub user info');
    }

    const existing = await this.prisma.gitProvider.findFirst({
      where: { userId, provider: 'GITHUB', username: userInfo.username },
    });
    const row = {
      provider: 'GITHUB',
      name: existing?.name || `${userInfo.username} (github)`,
      token: this.encryption.encrypt(data.access_token),
      authMode: 'OAUTH',
      refreshToken: data.refresh_token ? this.encryption.encrypt(data.refresh_token) : null,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
      scopes: data.scope || null,
      username: userInfo.username,
      avatarUrl: userInfo.avatarUrl,
    };
    if (existing) {
      await this.prisma.gitProvider.update({ where: { id: existing.id }, data: row });
    } else {
      await this.prisma.gitProvider.create({ data: { userId, ...row } });
    }
    return { state: 'authorized' };
  }

  // ── Used by the self-update webhook auto-installer ─────────────────

  async getGithubAccessToken(userId: string): Promise<string> {
    const gp = await this.prisma.gitProvider.findFirst({
      where: { userId, provider: 'GITHUB', authMode: 'OAUTH' },
      orderBy: { createdAt: 'desc' },
    });
    if (!gp) {
      throw new BadRequestException(
        'No GitHub OAuth connection found. Sign in with GitHub from Settings → Git first.',
      );
    }
    const refreshed = await this.refreshGithubToken(gp);
    return this.encryption.decrypt(refreshed.token);
  }

  /**
   * Refresh-if-stale for OAuth tokens.
   *
   * GitHub user-to-server tokens expire ~8h after issue, so a connection
   * that worked at deploy time is dead by the next morning. When `expiresAt`
   * is within the skew window (already past or < 5 min away) and a
   * refresh token exists, we exchange it for a fresh access token.
   *
   * Device flow is a public client: there is no client secret, and GitHub's
   * refresh grant works for public clients with `client_id` alone (the same
   * client_id we used to obtain the device code). If the OAuth App has refresh
   * tokens disabled, no `refreshToken` is stored — we leave the row untouched
   * and return it as-is, which also preserves PAT / non-refresh OAuth.
   *
   * Concurrency: two simultaneous deploys would both spend the single-use
   * refresh token and one would get a revoked-token error. We guard with an
   * `updateMany` that carries the current `expiresAt` as a precondition, so
   * only one refresh commits; the loser re-reads the freshly-written row.
   */
  async refreshGithubToken(gp: {
    id: string;
    token: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  }): Promise<{ token: string }> {
    const SKEW_MS = 5 * 60 * 1000;
    const stale = gp.expiresAt
      ? gp.expiresAt.getTime() - Date.now() < SKEW_MS
      : false;
    // Non-refresh OAuth (no refreshToken) and PAT keep working untouched.
    if (!stale || !gp.refreshToken) {
      return { token: gp.token };
    }

    const clientId = this.githubClientId();
    const body: Record<string, string> = {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: this.encryption.decrypt(gp.refreshToken),
    };
    // Web-flow / confidential apps configure a secret; device-flow public
    // clients don't and refresh on client_id alone.
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if (clientSecret) {
      body.client_secret = clientSecret;
    }

    let data: any;
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      data = await res.json();
    } catch (e) {
      this.logger.warn(`refreshGithubToken: ${(e as Error).message}`);
      return { token: gp.token };
    }
    if (data.error || !data.access_token) {
      this.logger.warn(
        `refreshGithubToken: ${data.error_description || data.error || 'missing access_token'}`,
      );
      return { token: gp.token };
    }

    const newToken = this.encryption.encrypt(data.access_token);
    const newRefreshToken = data.refresh_token
      ? this.encryption.encrypt(data.refresh_token)
      : gp.refreshToken;
    const newExpiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000)
      : null;

    // Only one concurrent caller wins: the precondition pins the row to the
    // expiresAt we read, so a racing refresh that already committed bumps it
    // and our update matches zero rows.
    const result = await this.prisma.gitProvider.updateMany({
      where: { id: gp.id, expiresAt: gp.expiresAt },
      data: {
        token: newToken,
        refreshToken: newRefreshToken,
        expiresAt: newExpiresAt,
      },
    });
    if (result.count === 0) {
      // Lost the race — another refresh already wrote a fresh token. Re-read.
      const current = await this.prisma.gitProvider.findUnique({
        where: { id: gp.id },
      });
      return { token: current?.token ?? gp.token };
    }
    return { token: newToken };
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async fetchGithubUser(token: string): Promise<{ username: string; avatarUrl: string } | null> {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return null;
      const d: any = await res.json();
      return { username: d.login, avatarUrl: d.avatar_url };
    } catch (e) {
      this.logger.warn(`fetchGithubUser: ${(e as Error).message}`);
      return null;
    }
  }
}
