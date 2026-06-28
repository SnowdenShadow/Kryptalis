import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { TerminalService } from './terminal.service';

// Resolve a containerized app's target for both local + remote, and verify the
// ephemeral-account lifecycle for remote. The ed25519 key conversion is parsed
// back to prove the agent (golang.org/x/crypto/ssh) would accept it.

function makeService(over: { sftp?: any; app?: any } = {}) {
  const prisma: any = {
    application: { findUnique: vi.fn().mockResolvedValue(over.app ?? null) },
  };
  const sftp: any = over.sftp ?? {
    createEphemeralShellAccount: vi.fn().mockResolvedValue({ id: 'eph1' }),
    removeEphemeralShellAccount: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new TerminalService(prisma, sftp);
  return { svc, prisma, sftp };
}

describe('TerminalService.resolveTarget', () => {
  it('local app → docker exec target with the resolved container name', async () => {
    const { svc } = makeService({
      app: {
        id: 'app1', name: 'My App', containerName: 'dockcontrol-my-app-app1',
        framework: 'DOCKER_COMPOSE', phpWebServer: null,
        server: { id: 's', host: '127.0.0.1' }, project: null,
      },
    });
    const t = await svc.resolveTarget('app1');
    expect(t.kind).toBe('local');
    if (t.kind === 'local') expect(t.containerName).toBe('dockcontrol-my-app-app1');
  });

  it('PHP_SITE nginx app targets the -fpm sidecar', async () => {
    const { svc } = makeService({
      app: {
        id: 'app2', name: 'Site', containerName: 'dockcontrol-site-app2',
        framework: 'PHP_SITE', phpWebServer: 'nginx',
        server: { id: 's', host: 'localhost' }, project: null,
      },
    });
    const t = await svc.resolveTarget('app2');
    if (t.kind === 'local') expect(t.containerName).toBe('dockcontrol-site-app2-fpm');
  });

  it('remote app → provisions an ephemeral shell account + returns a private key', async () => {
    const sftp = {
      createEphemeralShellAccount: vi.fn().mockResolvedValue({ id: 'eph1' }),
      removeEphemeralShellAccount: vi.fn().mockResolvedValue(undefined),
    };
    const { svc } = makeService({
      sftp,
      app: {
        id: 'app3', name: 'Presta', containerName: 'dockcontrol-presta-app3',
        framework: 'DOCKER_COMPOSE', phpWebServer: null,
        server: { id: 'srv9', host: '203.0.113.7' }, project: null,
      },
    });
    const t = await svc.resolveTarget('app3');
    expect(t.kind).toBe('remote');
    if (t.kind !== 'remote') return;
    expect(t.host).toBe('203.0.113.7');
    expect(t.port).toBe(2522);
    expect(t.username).toMatch(/^dcterm-[0-9a-f]{12}$/);
    expect(t.privateKey).toContain('PRIVATE KEY');

    // The account was created with the OpenSSH-format public key for THIS app.
    const arg = sftp.createEphemeralShellAccount.mock.calls[0][0];
    expect(arg.applicationId).toBe('app3');
    expect(arg.serverId).toBe('srv9');
    expect(arg.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/);

    // cleanup revokes the account.
    await t.cleanup();
    expect(sftp.removeEphemeralShellAccount).toHaveBeenCalledWith('eph1', 'srv9');
  });

  it('the ed25519 OpenSSH key it generates has the correct wire format + matches the private key', async () => {
    const sftp = {
      createEphemeralShellAccount: vi.fn().mockResolvedValue({ id: 'eph1' }),
      removeEphemeralShellAccount: vi.fn(),
    };
    const { svc } = makeService({
      sftp,
      app: {
        id: 'a', name: 'A', containerName: 'dockcontrol-a-a',
        framework: 'DOCKER', phpWebServer: null,
        server: { id: 's', host: '198.51.100.2' }, project: null,
      },
    });
    const t = await svc.resolveTarget('a');
    if (t.kind !== 'remote') throw new Error('expected remote');
    const pub = sftp.createEphemeralShellAccount.mock.calls[0][0].publicKey as string;

    // Decode the SSH wire format (the exact bytes the Go agent's
    // ssh.ParseAuthorizedKey reads): string "ssh-ed25519" + string <32-byte key>.
    const [prefix, b64] = pub.split(' ');
    expect(prefix).toBe('ssh-ed25519');
    const wire = Buffer.from(b64, 'base64');
    const readStr = (buf: Buffer, off: number) => {
      const n = buf.readUInt32BE(off);
      return { val: buf.subarray(off + 4, off + 4 + n), next: off + 4 + n };
    };
    const a = readStr(wire, 0);
    expect(a.val.toString()).toBe('ssh-ed25519');
    const b = readStr(wire, a.next);
    expect(b.val.length).toBe(32); // raw ed25519 public key
    expect(b.next).toBe(wire.length); // no trailing garbage

    // The 32 raw bytes must equal the private key's actual public half.
    const privDer = crypto
      .createPublicKey(crypto.createPrivateKey(t.privateKey))
      .export({ type: 'spki', format: 'der' }) as Buffer;
    const rawFromPriv = privDer.subarray(privDer.length - 32);
    expect(Buffer.compare(b.val, rawFromPriv)).toBe(0);
  });
});

describe('TerminalService not-found', () => {
  beforeEach(() => vi.clearAllMocks());
  it('throws when the app does not exist', async () => {
    const { svc } = makeService({ app: null });
    await expect(svc.resolveTarget('nope')).rejects.toThrow();
  });
});
