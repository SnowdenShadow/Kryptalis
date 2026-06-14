import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { slugify } from './applications.service';
import { assertCloneHostAllowed } from '../git-providers/git-providers.service';
import { BadRequestException } from '@nestjs/common';

describe('slugify', () => {
  it('lowercases and strips accents', () => {
    expect(slugify('Café Élégant')).toBe('cafe-elegant');
  });

  it('replaces special characters with dashes and trims them', () => {
    expect(slugify('  My App! (v2) ')).toBe('my-app-v2');
    expect(slugify('a__b..c')).toBe('a-b-c');
  });

  it('truncates to 48 characters', () => {
    expect(slugify('x'.repeat(100))).toBe('x'.repeat(48));
    expect(slugify('x'.repeat(100)).length).toBe(48);
  });

  it("falls back to 'app' for empty or symbol-only input", () => {
    expect(slugify('')).toBe('app');
    expect(slugify('!!!')).toBe('app');
  });
});

describe('assertCloneHostAllowed', () => {
  it('rejects a gitUrl whose host does not match the provider host', () => {
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'https://evil.example.com/x.git'),
    ).toThrow(BadRequestException);
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'https://gitlab.com/me/x.git'),
    ).toThrow(/does not match the selected provider/);
  });

  it('passes when the host matches the selected provider', () => {
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'https://github.com/me/x.git'),
    ).not.toThrow();
    expect(() =>
      assertCloneHostAllowed('GITLAB', 'https://gitlab.com/me/x.git'),
    ).not.toThrow();
    expect(() =>
      assertCloneHostAllowed('BITBUCKET', 'https://bitbucket.org/me/x.git'),
    ).not.toThrow();
  });

  it('rejects non-https and private/loopback hosts', () => {
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'http://github.com/me/x.git'),
    ).toThrow(/https/);
    // one-shot PAT path (no provider) still blocks SSRF targets
    expect(() =>
      assertCloneHostAllowed(null, 'https://127.0.0.1/x.git'),
    ).toThrow(BadRequestException);
    expect(() =>
      assertCloneHostAllowed(null, 'https://192.168.1.5/x.git'),
    ).toThrow(BadRequestException);
    expect(() =>
      assertCloneHostAllowed(null, 'https://localhost/x.git'),
    ).toThrow(BadRequestException);
  });

  it('allows an arbitrary public host on the one-shot PAT path (no provider)', () => {
    expect(() =>
      assertCloneHostAllowed(null, 'https://git.mycorp.com/me/x.git'),
    ).not.toThrow();
  });
});
