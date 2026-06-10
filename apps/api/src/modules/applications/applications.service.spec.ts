import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { slugify } from './applications.service';

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
