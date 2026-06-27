import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import { ConflictException } from '@nestjs/common';
import {
  timingSafeStrEq,
  refToBranch,
  extractPushBranch,
  isReplay,
  ApplicationWebhooksController,
} from './webhooks.controller';

describe('timingSafeStrEq', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeStrEq('sha256=abc123', 'sha256=abc123')).toBe(true);
    expect(timingSafeStrEq('', '')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeStrEq('aaaa', 'aaab')).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    expect(timingSafeStrEq('short', 'much-longer-string')).toBe(false);
    expect(timingSafeStrEq('x', '')).toBe(false);
  });
});

describe('refToBranch', () => {
  it('strips refs/heads/ prefix to the bare branch name', () => {
    expect(refToBranch('refs/heads/main')).toBe('main');
    expect(refToBranch('refs/heads/feature/x')).toBe('feature/x');
  });

  it('returns undefined for tag refs (a tag is not a branch)', () => {
    // Regression: a tag 'refs/tags/main' must NOT resolve to branch 'main'.
    expect(refToBranch('refs/tags/main')).toBeUndefined();
    expect(refToBranch('refs/tags/v1.0.0')).toBeUndefined();
  });

  it('returns undefined for other ref namespaces and missing ref', () => {
    expect(refToBranch('refs/remotes/origin/main')).toBeUndefined();
    expect(refToBranch(undefined)).toBeUndefined();
  });

  it('passes through a bare branch name', () => {
    expect(refToBranch('main')).toBe('main');
  });
});

describe('extractPushBranch', () => {
  it('reads GitHub/GitLab branch from top-level ref', () => {
    expect(extractPushBranch({ ref: 'refs/heads/main' })).toBe('main');
  });

  it('reads Bitbucket branch from push.changes[].new.name', () => {
    const body = {
      push: { changes: [{ new: { type: 'branch', name: 'develop' } }] },
    };
    expect(extractPushBranch(body)).toBe('develop');
  });

  it('ignores Bitbucket tag changes (new.type !== branch)', () => {
    const body = {
      push: { changes: [{ new: { type: 'tag', name: 'v1' } }] },
    };
    expect(extractPushBranch(body)).toBeUndefined();
  });

  it('returns undefined for a GitHub tag push', () => {
    expect(extractPushBranch({ ref: 'refs/tags/v1' })).toBeUndefined();
  });

  it('returns undefined when no branch info present', () => {
    expect(extractPushBranch({})).toBeUndefined();
    expect(extractPushBranch({ push: { changes: [] } })).toBeUndefined();
  });
});

describe('isReplay (in-memory delivery dedup)', () => {
  it('returns false the first time and true on replay of the same id', () => {
    const id = `test-${Math.random()}`;
    expect(isReplay(id)).toBe(false);
    expect(isReplay(id)).toBe(true);
  });

  it('treats distinct ids independently', () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    expect(isReplay(a)).toBe(false);
    expect(isReplay(b)).toBe(false);
  });

  it('skips dedup when no delivery id is present (does not break delivery)', () => {
    expect(isReplay(undefined)).toBe(false);
    expect(isReplay(undefined)).toBe(false);
  });
});

describe('ApplicationWebhooksController.receive — inflight 409 → benign skip', () => {
  const SECRET = 'whsec_test';
  const body = { ref: 'refs/heads/main' };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

  function makeController(redeployImpl: () => Promise<any>) {
    const prisma = {
      application: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'app1',
          webhookSecret: 'enc',
          autoDeploy: true,
          gitBranch: 'main',
          project: { userId: 'owner1' },
        }),
      },
    } as any;
    const apps = { redeploy: vi.fn(redeployImpl) } as any;
    const encryption = { decrypt: vi.fn(() => SECRET) } as any;
    const controller = new ApplicationWebhooksController(prisma, apps, encryption);
    const req = { rawBody: raw } as any;
    return { controller, apps, req };
  }

  it('a push during an active deploy returns {skipped} instead of bubbling the 409 to the provider', async () => {
    const { controller, apps, req } = makeController(async () => {
      throw new ConflictException('A deployment is already running');
    });
    const res = await controller.receive(
      'app1', body, req, sig, undefined, undefined, undefined, undefined,
      // unique delivery id so the in-memory replay guard doesn't short-circuit
      `deliv-${Math.random()}`,
    );
    expect(res).toEqual({ skipped: true, reason: 'deploy already in progress' });
    expect(apps.redeploy).toHaveBeenCalledTimes(1);
  });

  it('a successful redeploy returns {triggered:true}', async () => {
    const { controller, req } = makeController(async () => ({ deploymentId: 'd1' }));
    const res = await controller.receive(
      'app1', body, req, sig, undefined, undefined, undefined, undefined,
      `deliv-${Math.random()}`,
    );
    expect(res).toEqual({ triggered: true });
  });

  it('a NON-conflict error still propagates (not swallowed as a skip)', async () => {
    const { controller, req } = makeController(async () => {
      throw new Error('clone failed');
    });
    await expect(
      controller.receive(
        'app1', body, req, sig, undefined, undefined, undefined, undefined,
        `deliv-${Math.random()}`,
      ),
    ).rejects.toThrow('clone failed');
  });
});
