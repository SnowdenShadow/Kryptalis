'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { translations } from './translations';

type Locale = 'en' | 'fr';

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType>({
  locale: 'en',
  setLocale: () => {},
  t: (key) => key,
});

/**
 * Read the user's saved locale BEFORE the first render. localStorage is
 * client-only, so SSR still gets 'en' — but a tiny inline `<script>` in the
 * root layout already set document.documentElement.lang before React boots,
 * and on the client we lazy-init useState from localStorage so the very
 * first hydrated render uses the right strings. No EN→FR flash.
 *
 * First visit (nothing saved): honor the BROWSER's language — a French
 * operator landing on the setup flow gets French without having to find
 * a language switcher first. Their explicit pick (setLocale) wins forever
 * after.
 */
function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = localStorage.getItem('kryptalis-lang') as Locale | null;
    if (saved && translations[saved]) return saved;
  } catch {}
  try {
    const nav = (navigator.languages?.[0] || navigator.language || '').toLowerCase();
    if (nav.startsWith('fr')) return 'fr';
  } catch {}
  return 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('kryptalis-lang', newLocale);
    document.documentElement.lang = newLocale;
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const raw = translations[locale]?.[key] || translations['en']?.[key] || key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  return useContext(I18nContext);
}
