import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { assertComposeSafe, checkImportedComposeSafety } from './compose-safety';

const doc = (services: string) => `services:\n${services}`;

describe('assertComposeSafe', () => {
  it('passes a safe compose (named volume → abs container path)', () => {
    expect(() =>
      assertComposeSafe(doc(`  web:\n    image: nginx\n    volumes:\n      - data:/var/www\n`)),
    ).not.toThrow();
  });

  it('is a no-op for empty/undefined (caller gates on "is there a compose")', () => {
    expect(() => assertComposeSafe(undefined)).not.toThrow();
    expect(() => assertComposeSafe('')).not.toThrow();
    expect(() => assertComposeSafe(null)).not.toThrow();
  });

  it('rejects privileged: true with a 400', () => {
    expect(() => assertComposeSafe(doc(`  x:\n    image: alpine\n    privileged: true\n`))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a docker-socket bind-mount (the host-root escape)', () => {
    const c = doc(`  evil:\n    image: alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`);
    expect(() => assertComposeSafe(c)).toThrow(BadRequestException);
  });

  it('rejects a / bind-mount, cap_add, and pid: host', () => {
    expect(() => assertComposeSafe(doc(`  x:\n    image: a\n    volumes:\n      - /:/host\n`))).toThrow(
      BadRequestException,
    );
    expect(() => assertComposeSafe(doc(`  x:\n    image: a\n    cap_add:\n      - SYS_ADMIN\n`))).toThrow(
      BadRequestException,
    );
    expect(() => assertComposeSafe(doc(`  x:\n    image: a\n    pid: host\n`))).toThrow(
      BadRequestException,
    );
  });

  it('surfaces the underlying problem text in the message', () => {
    try {
      assertComposeSafe(doc(`  x:\n    image: a\n    privileged: true\n`));
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(String(e.message)).toMatch(/privileged/i);
    }
  });

  it('re-exports the raw checker for the requiresHostAccess flag use-case', () => {
    expect(checkImportedComposeSafety(doc(`  x:\n    image: a\n    privileged: true\n`)).length).toBeGreaterThan(0);
    expect(checkImportedComposeSafety(doc(`  x:\n    image: a\n`))).toEqual([]);
  });
});
