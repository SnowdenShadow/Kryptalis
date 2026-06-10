import { describe, it, expect } from 'vitest';
import { translations } from './translations';

/**
 * EN/FR symmetry guard. The dictionaries are flat `Record<key, string>`
 * maps; a key present in one locale but not the other means the UI shows
 * the raw key (or English) to half the users. This exact class of bug has
 * already shipped once (missing `common.logout` in FR).
 */
describe('i18n translations', () => {
  const locales = Object.keys(translations);

  it('exposes exactly the en and fr locales', () => {
    expect(locales.sort()).toEqual(['en', 'fr']);
  });

  it('has the exact same keys in EN and FR', () => {
    const en = Object.keys(translations.en).sort();
    const fr = Object.keys(translations.fr).sort();

    const missingInFr = en.filter((k) => !(k in translations.fr));
    const missingInEn = fr.filter((k) => !(k in translations.en));

    expect(missingInFr, `keys present in EN but missing in FR: ${missingInFr.join(', ')}`).toEqual([]);
    expect(missingInEn, `keys present in FR but missing in EN: ${missingInEn.join(', ')}`).toEqual([]);
    expect(fr).toEqual(en);
  });

  it.each(locales)('locale %s has no empty or non-string values', (locale) => {
    const offenders = Object.entries(translations[locale])
      .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
      .map(([k]) => k);
    expect(offenders, `empty/non-string values in ${locale}: ${offenders.join(', ')}`).toEqual([]);
  });

  it('uses the same {placeholders} in EN and FR for every key', () => {
    const placeholders = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    const mismatches: string[] = [];
    for (const key of Object.keys(translations.en)) {
      const fr = translations.fr[key];
      if (fr === undefined) continue; // covered by the symmetry test
      const enPh = placeholders(translations.en[key]).join(',');
      const frPh = placeholders(fr).join(',');
      if (enPh !== frPh) mismatches.push(`${key} (en: [${enPh}] vs fr: [${frPh}])`);
    }
    expect(mismatches, `placeholder drift: ${mismatches.join('; ')}`).toEqual([]);
  });
});
