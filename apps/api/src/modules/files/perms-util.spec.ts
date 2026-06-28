import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseChmodMode, parseChownOwner } from './perms-util';

describe('parseChmodMode', () => {
  it('accepts standard octal strings', () => {
    expect(parseChmodMode('755')).toBe(0o755);
    expect(parseChmodMode('644')).toBe(0o644);
    expect(parseChmodMode('775')).toBe(0o775);
    expect(parseChmodMode('777')).toBe(0o777);
    expect(parseChmodMode('0664')).toBe(0o664);
    expect(parseChmodMode('000')).toBe(0);
  });

  it('accepts an already-numeric mode', () => {
    expect(parseChmodMode(0o755)).toBe(0o755);
  });

  it('REJECTS setuid / setgid / sticky bits', () => {
    expect(() => parseChmodMode('4755')).toThrow(BadRequestException); // setuid
    expect(() => parseChmodMode('2755')).toThrow(BadRequestException); // setgid
    expect(() => parseChmodMode('1777')).toThrow(BadRequestException); // sticky
    expect(() => parseChmodMode(0o4755)).toThrow(BadRequestException);
  });

  it('REJECTS junk / out-of-range', () => {
    expect(() => parseChmodMode('abc')).toThrow(BadRequestException);
    expect(() => parseChmodMode('99')).toThrow(BadRequestException);
    expect(() => parseChmodMode('888')).toThrow(BadRequestException); // 8 isn't octal
    expect(() => parseChmodMode(-1)).toThrow(BadRequestException);
    expect(() => parseChmodMode('')).toThrow(BadRequestException);
  });
});

describe('parseChownOwner', () => {
  it('accepts user and user:group names', () => {
    expect(parseChownOwner('www-data').raw).toBe('www-data');
    expect(parseChownOwner('www-data:www-data')).toMatchObject({ raw: 'www-data:www-data', numeric: false });
    expect(parseChownOwner('root').numeric).toBe(false);
    expect(parseChownOwner('_apt:_apt').numeric).toBe(false);
  });

  it('accepts numeric uid[:gid] and flags it numeric', () => {
    expect(parseChownOwner('1000')).toMatchObject({ numeric: true, uid: 1000 });
    expect(parseChownOwner('33:33')).toMatchObject({ numeric: true, uid: 33, gid: 33 });
  });

  it('REJECTS shell-metacharacter / whitespace injection', () => {
    for (const bad of [
      'www-data; rm -rf /',
      'www-data $(id)',
      'a b',
      'root\nwww-data',
      'user:group:extra',
      '../../etc',
      "'; reboot; '",
      'a`whoami`',
      '',
      'UPPERCASE', // names must be lowercase-start per our regex
    ]) {
      expect(() => parseChownOwner(bad), bad).toThrow(BadRequestException);
    }
  });

  it('REJECTS an absurdly long owner', () => {
    expect(() => parseChownOwner('a'.repeat(100))).toThrow(BadRequestException);
  });
});
