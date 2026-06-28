// PHP configuration for MARKETPLACE apps (PrestaShop, WordPress, phpMyAdmin,
// Nextcloud). These run on prebuilt official PHP images, so we can't add
// extensions or swap the web server (that's the PHP_SITE story). What we CAN
// do is drop a php.ini override into the image's conf.d via a bind-mounted
// side-file — exactly like PrestaShop's existing proxy side-files.
//
// This module is the bridge between the generic php.ini engine
// (php-site.constants.ts) and the marketplace deploy machinery
// (marketplace.service.ts / application-ops.service.ts).
import * as yaml from 'js-yaml';
import {
  PHP_MARKETPLACE_APPS,
  PHP_INI_SIDEFILE,
  phpIniMountFor,
} from '../marketplace/templates';
import { buildPhpIni, type PhpIniSettings } from './php-site.constants';

/** PrestaShop's installer warns unless short_open_tag is Off — apply by default. */
export const PRESTASHOP_DEFAULT_INI: PhpIniSettings = { short_open_tag: 'Off' };

/** Is this catalog slug a PHP marketplace app? (slug-based primitive.) */
export function isPhpMarketplaceSlug(slug: string | null | undefined): boolean {
  return !!slug && slug in PHP_MARKETPLACE_APPS;
}

/**
 * Side-file map for a known PHP marketplace slug. Used at INSTALL time, where
 * the catalog slug (data.appSlug) is known directly. Always includes the .ini
 * (empty-ish when no overrides) because the compose bind-mounts it.
 */
export function buildPhpIniSideFileForSlug(
  slug: string | null | undefined,
  phpIni: PhpIniSettings | null | undefined,
): Record<string, string> {
  if (!isPhpMarketplaceSlug(slug)) return {};
  return { [PHP_INI_SIDEFILE]: buildPhpIni(phpIni) };
}

/**
 * Recover the catalog slug (prestashop, wordpress, …) for a marketplace app.
 * It isn't a DB column, but the install bakes it into `containerName` as
 * `dockcontrol-<slug>-<id12>` (computeContainerName). We strip the fixed prefix
 * and the per-instance suffix to get the stem, then undo the one special case
 * (`redis` → `redis-app`). Returns null when it doesn't match that shape.
 */
export function marketplaceSlugOf(app: {
  containerName?: string | null;
  id?: string | null;
  marketplaceSlug?: string | null; // honored if a future column ever exists
}): string | null {
  if (app?.marketplaceSlug) return app.marketplaceSlug;
  const cn = app?.containerName;
  if (!cn || !cn.startsWith('dockcontrol-')) return null;
  let stem = cn.slice('dockcontrol-'.length);
  // Marketplace installs ALWAYS suffix the container with `-<id12>`
  // (computeContainerName). Classic git/Docker apps use `dockcontrol-<slug>`
  // with NO suffix — so we REQUIRE the suffix to avoid false-positiving a
  // classic app that merely happens to be named "wordpress"/"nextcloud"/…
  if (app?.id) {
    const id12 = app.id.slice(0, 12);
    if (!stem.endsWith(`-${id12}`)) return null; // not a marketplace install
    stem = stem.slice(0, -(id12.length + 1));
  } else {
    // No id to anchor on — require a trailing -<12 alnum> and strip it.
    const m = stem.match(/^(.*)-[a-z0-9]{12}$/i);
    if (!m) return null;
    stem = m[1];
  }
  return stem === 'redis-app' ? 'redis' : stem || null;
}

/** Is this app a PHP marketplace app (→ php.ini overrides are supported)? */
export function isPhpMarketplace(app: {
  framework?: string | null;
  containerName?: string | null;
  id?: string | null;
  marketplaceSlug?: string | null;
}): boolean {
  const slug = marketplaceSlugOf(app);
  return !!slug && slug in PHP_MARKETPLACE_APPS;
}

/**
 * Can this app's php.ini be configured at all? True for native PHP_SITE apps
 * and for PHP marketplace apps. Surfaced to the dashboard as `phpConfigurable`
 * so the UI doesn't have to re-derive the rule.
 */
export function isPhpConfigurable(app: {
  framework?: string | null;
  containerName?: string | null;
  id?: string | null;
  marketplaceSlug?: string | null;
}): boolean {
  return app?.framework === 'PHP_SITE' || isPhpMarketplace(app);
}

/**
 * The generated side-file ({ 'zz-dockcontrol-php.ini': '<contents>' }) for a PHP
 * marketplace app. ALWAYS returns the file (empty-ish when no overrides) because
 * the compose bind-mounts it — a missing source makes Docker create a directory
 * at the mount point and the container breaks. Returns {} for non-PHP apps.
 */
export function buildPhpIniSideFile(app: {
  framework?: string | null;
  containerName?: string | null;
  id?: string | null;
  marketplaceSlug?: string | null;
  phpIni?: unknown;
}): Record<string, string> {
  if (!isPhpMarketplace(app)) return {};
  return { [PHP_INI_SIDEFILE]: buildPhpIni(app.phpIni as PhpIniSettings | null) };
}

/**
 * Ensure a PHP marketplace app's compose mounts the php.ini side-file. Apps
 * installed BEFORE this feature have a compose without the mount; we inject it
 * into the right service via js-yaml (never string concat → no YAML corruption)
 * so a redeploy starts honoring php.ini. Idempotent: returns the input
 * unchanged when the mount is already present or the app isn't PHP marketplace.
 *
 * `hostDir` is the bind SOURCE base (absolute host path of the app dir). It is
 * REQUIRED for a late injection because `__HOST_APP_DIR__` is only substituted
 * at install time — injecting the raw placeholder would make Docker treat it as
 * a path relative to the compose dir and create a junk directory there.
 *
 * @returns { compose, changed } — the (possibly) rewritten compose YAML.
 */
export function ensurePhpIniMount(
  app: { containerName?: string | null; id?: string | null; marketplaceSlug?: string | null },
  composeYaml: string,
  hostDir: string,
): { compose: string; changed: boolean } {
  const slug = marketplaceSlugOf(app);
  if (!slug || !(slug in PHP_MARKETPLACE_APPS)) return { compose: composeYaml, changed: false };
  const mount = phpIniMountFor(slug, hostDir);
  if (!mount) return { compose: composeYaml, changed: false };

  let doc: any;
  try {
    doc = yaml.load(composeYaml);
  } catch {
    // Unparseable compose — don't touch it; the redeploy will surface the error.
    return { compose: composeYaml, changed: false };
  }
  const svcName = PHP_MARKETPLACE_APPS[slug].service;
  const svc = doc?.services?.[svcName];
  if (!svc || typeof svc !== 'object') return { compose: composeYaml, changed: false };

  const vols: string[] = Array.isArray(svc.volumes) ? svc.volumes : [];
  // Match by mount TARGET (the in-container conf.d path) so an install-time
  // host-path rewrite (__HOST_APP_DIR__ → /opt/dockcontrol/...) still counts as
  // "already present" and we don't append a duplicate.
  const target = `${PHP_MARKETPLACE_APPS[slug].confDir}/${PHP_INI_SIDEFILE}`;
  const already = vols.some((v) => typeof v === 'string' && v.includes(target));
  if (already) return { compose: composeYaml, changed: false };

  svc.volumes = [...vols, mount];
  const out = yaml.dump(doc, { lineWidth: -1 });
  return { compose: out, changed: true };
}
