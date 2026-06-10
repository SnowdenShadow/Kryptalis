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
 *     Every Kryptalis install can use the same app without any operator
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
 *   client secret) is NOT used in device flow at all.
 *
 *   Configuration: set GITHUB_OAUTH_CLIENT_ID in env to the OAuth App you
 *   registered on github.com/settings/developers. There is deliberately no
 *   baked-in default: shipping a placeholder client_id would point every
 *   install's GitHub login at an OAuth app the operator doesn't control.
 *   When unset, /git-providers/oauth/github/status reports
 *   configured:false and the device-flow endpoints refuse with a 400.
 */
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
    return process.env.GITHUB_OAUTH_CLIENT_ID || '';
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
    return this.encryption.decrypt(gp.token);
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
