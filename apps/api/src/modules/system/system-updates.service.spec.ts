import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SystemUpdatesService } from './system-updates.service';

/**
 * Unit tests for the self-update poll() state machine — the in-memory logic
 * that decides UP_TO_DATE / UPDATE_AVAILABLE / ERROR and whether to auto-run
 * update.sh. We stub the GitHub fetch, the on-disk SHA read, and runUpdate()
 * (no real docker spawn) so the tests are pure and fast.
 *
 * Focus: the hardening added after the audit — a SHA that just failed must
 * stay ERROR and NOT auto-retry every tick, even once `git reset` has put the
 * new (broken) SHA on disk; and a genuinely newer commit clears the failure.
 */

function makeService(repo = 'owner/repo') {
  const svc = new SystemUpdatesService();
  // Pin the repo (resolveRepo normally parses .git/config).
  (svc as any).state.repo = repo;
  // Never spawn a real updater — record that an auto-run WAS requested.
  const runUpdate = vi.fn().mockResolvedValue(undefined);
  (svc as any).runUpdate = runUpdate;
  return { svc, runUpdate };
}

/** Stub global fetch to return a commit with the given sha (200 + etag). */
function mockGithubSha(sha: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ sha }),
      text: async () => '',
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SystemUpdatesService.poll — sticky failure', () => {
  let svc: SystemUpdatesService;
  let runUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ svc, runUpdate } = makeService());
  });

  it('auto-runs the update when a newer commit appears', async () => {
    (svc as any).state.currentSha = 'a'.repeat(40);
    vi.spyOn(svc as any, 'readCurrentSha').mockResolvedValue('a'.repeat(40));
    mockGithubSha('b'.repeat(40));

    await (svc as any).poll();

    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(svc.getStatus().status).toBe('UPDATE_AVAILABLE');
  });

  it('a SHA that just failed stays ERROR and does NOT auto-retry, even though it is now on disk', async () => {
    const failed = 'c'.repeat(40);
    // Simulate the post-failure state: update.sh reset the tree to `failed`
    // (so it is on disk) but the build/migration failed → lastFailedSha=failed.
    (svc as any).state.currentSha = failed;
    (svc as any).state.latestSha = failed;
    (svc as any).lastFailedSha = failed;
    vi.spyOn(svc as any, 'readCurrentSha').mockResolvedValue(failed);
    mockGithubSha(failed);

    await (svc as any).poll();

    expect(runUpdate).not.toHaveBeenCalled();
    expect(svc.getStatus().status).toBe('ERROR');
    // Crucially NOT reported as up to date despite currentSha === latestSha.
    expect(svc.getStatus().status).not.toBe('UP_TO_DATE');
  });

  it('a genuinely newer commit clears the prior failure and runs again', async () => {
    const failed = 'c'.repeat(40);
    const fresh = 'd'.repeat(40);
    (svc as any).state.currentSha = failed;
    (svc as any).lastFailedSha = failed;
    vi.spyOn(svc as any, 'readCurrentSha').mockResolvedValue(failed);
    mockGithubSha(fresh);

    await (svc as any).poll();

    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect((svc as any).lastFailedSha).toBeNull();
    expect(svc.getStatus().status).toBe('UPDATE_AVAILABLE');
  });

  it('forceUpdate clears the sticky failure so a manual retry is allowed', async () => {
    const failed = 'c'.repeat(40);
    (svc as any).lastFailedSha = failed;
    (svc as any).updating = false;

    await svc.forceUpdate();

    expect((svc as any).lastFailedSha).toBeNull();
    expect(runUpdate).toHaveBeenCalledTimes(1);
  });
});
