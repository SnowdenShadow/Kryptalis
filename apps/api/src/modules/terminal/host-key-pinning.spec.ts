import { describe, it, expect } from 'vitest';
import { createSha256Fp, decideHostKey } from './terminal.gateway';

/**
 * H-4: trust-on-first-use SSH host-key pinning for the API→agent bridge.
 */
describe('createSha256Fp', () => {
  it('is deterministic and base64', () => {
    const a = createSha256Fp(Buffer.from('hostkey-blob'));
    const b = createSha256Fp(Buffer.from('hostkey-blob'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('differs for different keys', () => {
    expect(createSha256Fp(Buffer.from('k1'))).not.toBe(createSha256Fp(Buffer.from('k2')));
  });
});

describe('decideHostKey (TOFU)', () => {
  it('first use → accept and store', () => {
    expect(decideHostKey(null, 'fp1')).toEqual({ accept: true, store: true });
  });

  it('matching pin → accept, no store', () => {
    expect(decideHostKey('fp1', 'fp1')).toEqual({ accept: true, store: false });
  });

  it('mismatched pin → refuse (possible MITM), no store', () => {
    expect(decideHostKey('fp1', 'fp2')).toEqual({ accept: false, store: false });
  });
});
