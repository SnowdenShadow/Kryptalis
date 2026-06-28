/**
 * Supported PHP runtime versions for the PHP_SITE hosting type. Each maps to an
 * official `php:<version>-apache` Docker image tag (Debian-based, mod_php).
 *
 * Ordered newest-first so the UI dropdown defaults to the most current release.
 * Keep this list in sync with the tags Docker Hub still publishes — dropping an
 * EOL tag here stops new sites using it without touching existing deploys.
 */
export const SUPPORTED_PHP_VERSIONS = ['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4'] as const;

export type PhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

/**
 * Default chosen when the user doesn't pick one. We default to 8.4 (the newest
 * release with broad extension/framework maturity) rather than 8.5 (offered,
 * but very new — Nov 2025), so a "just deploy" PHP site lands on the safest
 * current version. Users wanting the absolute latest can pick 8.5 in the UI.
 */
export const DEFAULT_PHP_VERSION: PhpVersion = '8.4';

/** Internal port the php:*-apache image listens on (mod_php under Apache). */
export const PHP_SITE_CONTAINER_PORT = 80;

export function isSupportedPhpVersion(v: string | null | undefined): v is PhpVersion {
  return !!v && (SUPPORTED_PHP_VERSIONS as readonly string[]).includes(v);
}

/** Supported web servers for a PHP site. */
export const PHP_WEB_SERVERS = ['apache', 'nginx'] as const;
export type PhpWebServer = (typeof PHP_WEB_SERVERS)[number];
export const DEFAULT_PHP_WEB_SERVER: PhpWebServer = 'apache';

/**
 * The base extension pack — ALWAYS installed (DB drivers + common web pack) so
 * WordPress/Laravel/Symfony/PrestaShop run out of the box. `aptLibs` are the
 * -dev libraries docker-php-ext-install compiles against; `configure` is an
 * optional `docker-php-ext-configure` flag string.
 */
const BASE_DOCKER_EXTS = ['pdo_mysql', 'mysqli', 'pdo_pgsql', 'pgsql', 'gd', 'zip', 'intl', 'opcache', 'bcmath'];
const BASE_APT_LIBS = ['libpq-dev', 'libpng-dev', 'libjpeg-dev', 'libfreetype6-dev', 'libzip-dev', 'libicu-dev'];

/**
 * OPTIONAL extensions the user can toggle ON (added to the base pack). Each
 * declares how it's installed: `docker` (docker-php-ext-install) or `pecl`
 * (pecl install + docker-php-ext-enable), plus any apt -dev libs it needs.
 */
export interface PhpExtensionDef {
  name: string;
  label: string;
  via: 'docker' | 'pecl';
  aptLibs?: string[];
  // pecl package name when it differs from `name` (e.g. redis → redis).
  peclPkg?: string;
}
export const PHP_OPTIONAL_EXTENSIONS: PhpExtensionDef[] = [
  { name: 'mbstring', label: 'mbstring (multibyte strings)', via: 'docker', aptLibs: ['libonig-dev'] },
  { name: 'exif', label: 'exif (image metadata)', via: 'docker' },
  { name: 'soap', label: 'soap (SOAP/XML web services)', via: 'docker', aptLibs: ['libxml2-dev'] },
  { name: 'xsl', label: 'xsl (XSLT)', via: 'docker', aptLibs: ['libxslt1-dev'] },
  { name: 'gmp', label: 'gmp (arbitrary precision math)', via: 'docker', aptLibs: ['libgmp-dev'] },
  { name: 'pcntl', label: 'pcntl (process control — queues/workers)', via: 'docker' },
  { name: 'sockets', label: 'sockets', via: 'docker' },
  { name: 'redis', label: 'redis (cache/sessions)', via: 'pecl' },
  { name: 'imagick', label: 'imagick (ImageMagick image processing)', via: 'pecl', aptLibs: ['libmagickwand-dev'] },
];

const OPTIONAL_BY_NAME = new Map(PHP_OPTIONAL_EXTENSIONS.map((e) => [e.name, e]));
export function isSupportedPhpExtension(name: string): boolean {
  return OPTIONAL_BY_NAME.has(name);
}

/** php.ini keys we let the user override (validated + rendered into a .ini). */
export interface PhpIniSettings {
  memory_limit?: string;        // e.g. "256M"
  upload_max_filesize?: string; // e.g. "64M"
  post_max_size?: string;       // e.g. "64M"
  max_execution_time?: string;  // e.g. "120"
  timezone?: string;            // e.g. "Europe/Paris"
  short_open_tag?: string;      // "On" | "Off" (PrestaShop installer wants Off)
  max_input_vars?: string;      // e.g. "10000" (big forms / imports)
}
export const PHP_INI_KEYS: (keyof PhpIniSettings)[] = [
  'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'timezone',
  'short_open_tag', 'max_input_vars',
];

/** Per-framework presets: extensions to enable + php.ini tweaks. */
export interface PhpPresetDef {
  extensions: string[];
  ini: PhpIniSettings;
}
export const PHP_PRESETS: Record<string, PhpPresetDef> = {
  wordpress: { extensions: ['mbstring', 'exif', 'imagick'], ini: { upload_max_filesize: '64M', post_max_size: '64M', memory_limit: '256M' } },
  laravel: { extensions: ['mbstring', 'pcntl', 'redis'], ini: { memory_limit: '256M', max_execution_time: '120' } },
  symfony: { extensions: ['mbstring', 'xsl'], ini: { memory_limit: '256M' } },
};

/** Normalize a user extension list to known optional ones (dedup, drop unknown). */
export function sanitizePhpExtensions(exts: string[] | null | undefined): string[] {
  if (!exts) return [];
  return [...new Set(exts.filter((e) => OPTIONAL_BY_NAME.has(e)))];
}

/** Validate a php.ini value (no newlines/quotes — it lands in a .ini line). */
function cleanIniValue(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || !/^[A-Za-z0-9_./:+-]{1,32}$/.test(t)) return undefined;
  return t;
}

/**
 * Per-key validation on top of the generic charset guard. Booleans must be a
 * real On/Off (normalized to canonical case so the .ini is clean), counters
 * must be plain integers — this stops e.g. `short_open_tag = Off; evil` even
 * if a future charset change let it through, and keeps the rendered file tidy.
 */
function cleanIniKeyValue(key: keyof PhpIniSettings, v: unknown): string | undefined {
  const base = cleanIniValue(v);
  if (!base) return undefined;
  if (key === 'short_open_tag') {
    const low = base.toLowerCase();
    if (low === 'on' || low === '1' || low === 'true') return 'On';
    if (low === 'off' || low === '0' || low === 'false') return 'Off';
    return undefined;
  }
  if (key === 'max_input_vars') {
    return /^\d{1,7}$/.test(base) ? base : undefined;
  }
  return base;
}

function sanitizePhpIni(ini: Record<string, unknown> | null | undefined): PhpIniSettings {
  const out: PhpIniSettings = {};
  if (!ini) return out;
  for (const k of PHP_INI_KEYS) {
    const v = cleanIniKeyValue(k, (ini as any)[k]);
    if (v) (out as any)[k] = v;
  }
  return out;
}

/** Public, validated php.ini sanitizer — drops unknown keys + bad values. */
export function sanitizePhpIniInput(
  ini: Record<string, unknown> | null | undefined,
): PhpIniSettings {
  return sanitizePhpIni(ini);
}

/**
 * Resolve a PHP_SITE config from a create/update request: a named preset
 * expands into extensions + ini, then the explicit picks are merged on top
 * (explicit wins). Returns normalized, safe values ready to persist/deploy.
 */
export function resolvePhpConfig(input: {
  webServer?: string | null;
  extensions?: string[] | null;
  ini?: Record<string, unknown> | null;
  preset?: string | null;
}): { webServer: PhpWebServer; extensions: string[]; ini: PhpIniSettings; preset: string | null } {
  const webServer: PhpWebServer = input.webServer === 'nginx' ? 'nginx' : 'apache';
  const preset = input.preset && PHP_PRESETS[input.preset] ? input.preset : (input.preset || null);
  const presetDef = preset ? PHP_PRESETS[preset] : undefined;

  const extensions = sanitizePhpExtensions([
    ...(presetDef?.extensions || []),
    ...(input.extensions || []),
  ]);
  const ini: PhpIniSettings = { ...(presetDef?.ini || {}), ...sanitizePhpIni(input.ini) };
  return { webServer, extensions, ini, preset };
}

/**
 * Generate the Dockerfile for a PHP_SITE app.
 *  - apache → FROM php:<ver>-apache (mod_php, 1 container) + a2enmod rewrite.
 *  - nginx  → FROM php:<ver>-fpm (PHP-FPM; the compose adds an nginx service).
 * Base pack + chosen optional extensions; pecl ones via pecl install+enable.
 * The docroot is bind-mounted at runtime, so the image ships empty.
 */
export function buildPhpDockerfile(args: {
  version: string;
  webServer: PhpWebServer;
  extensions: string[];
}): string {
  // NB: the concrete version is injected at build time via the compose
  // `args: { PHP_VERSION }` (validated in runPhpSiteDeploy), which overrides the
  // ARG default below — so `args.version` isn't interpolated into the template.
  const tag = args.webServer === 'nginx' ? 'fpm' : 'apache';
  const opt = sanitizePhpExtensions(args.extensions).map((n) => OPTIONAL_BY_NAME.get(n)!);

  const aptLibs = [...new Set([...BASE_APT_LIBS, ...opt.flatMap((e) => e.aptLibs || [])])];
  const dockerExts = [...BASE_DOCKER_EXTS, ...opt.filter((e) => e.via === 'docker').map((e) => e.name)];
  const peclExts = opt.filter((e) => e.via === 'pecl');

  const lines: string[] = [
    '# syntax=docker/dockerfile:1',
    '# Generated by DockControl for a PHP_SITE app. Do not edit — regenerated on redeploy.',
    `ARG PHP_VERSION=${DEFAULT_PHP_VERSION}`,
    `FROM php:\${PHP_VERSION}-${tag}`,
    '',
    '# System libraries the PHP extensions compile against.',
    `RUN apt-get update && apt-get install -y --no-install-recommends \\`,
    `      ${aptLibs.join(' ')} \\`,
    ` && docker-php-ext-configure gd --with-jpeg --with-freetype \\`,
    ` && docker-php-ext-install -j"\$(nproc)" \\`,
    `      ${dockerExts.join(' ')} \\`,
  ];
  if (peclExts.length) {
    lines.push(
      ` && pecl install ${peclExts.map((e) => e.peclPkg || e.name).join(' ')} \\`,
      ` && docker-php-ext-enable ${peclExts.map((e) => e.name).join(' ')} \\`,
    );
  }
  lines.push(' && apt-get clean && rm -rf /var/lib/apt/lists/*', '');

  if (args.webServer === 'apache') {
    lines.push('# Pretty URLs (.htaccess rewrites — WordPress permalinks, Laravel, etc.).', 'RUN a2enmod rewrite', '', 'EXPOSE 80', '');
  } else {
    lines.push('# PHP-FPM listens on 9000; the nginx sidecar proxies to it.', 'EXPOSE 9000', '');
  }
  return lines.join('\n');
}

/** Render the user's php.ini overrides into a conf.d drop-in file. */
export function buildPhpIni(ini: PhpIniSettings | null | undefined): string {
  // Re-sanitize at render time too: this function is the single sink that
  // writes user values into a .ini, so validating here guarantees no unchecked
  // value ever reaches disk regardless of the caller.
  const safe = sanitizePhpIni(ini as Record<string, unknown> | null | undefined);
  const out: string[] = ['; Generated by DockControl — PHP overrides.'];
  if (safe.memory_limit) out.push(`memory_limit = ${safe.memory_limit}`);
  if (safe.upload_max_filesize) out.push(`upload_max_filesize = ${safe.upload_max_filesize}`);
  if (safe.post_max_size) out.push(`post_max_size = ${safe.post_max_size}`);
  if (safe.max_execution_time) out.push(`max_execution_time = ${safe.max_execution_time}`);
  if (safe.timezone) out.push(`date.timezone = ${safe.timezone}`);
  if (safe.short_open_tag) out.push(`short_open_tag = ${safe.short_open_tag}`);
  if (safe.max_input_vars) out.push(`max_input_vars = ${safe.max_input_vars}`);
  return out.join('\n') + '\n';
}

/** Parse a PHP byte-size string ("64M", "256M", "1G", "1024K", "512") to bytes. */
function phpSizeToBytes(v: string | undefined): number {
  if (!v) return 0;
  const m = /^(\d+)\s*([KMG])?$/i.exec(v.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || '').toUpperCase();
  return unit === 'G' ? n * 1024 ** 3 : unit === 'M' ? n * 1024 ** 2 : unit === 'K' ? n * 1024 : n;
}

/**
 * Nginx site config used in nginx mode — serves the docroot, FastCGI to php-fpm.
 *  - `fpmHost`: the UNIQUE php-fpm container name (e.g. dockcontrol-<slug>-fpm).
 *    We deliberately do NOT use the compose service alias `app:9000`: that alias
 *    is shared by every app-named service on the platform-wide `dockcontrol-apps`
 *    bridge, so Docker DNS would round-robin across tenants and could FastCGI a
 *    request to a FOREIGN container. The container_name is unique → no collision.
 *  - `ini`: the user's php.ini overrides — client_max_body_size is derived from
 *    upload_max_filesize / post_max_size so a raised PHP limit isn't silently
 *    capped by nginx's default (a >limit upload would 413 before reaching PHP).
 */
export function buildNginxConf(fpmHost: string, ini?: PhpIniSettings | null): string {
  const bodyBytes = Math.max(
    phpSizeToBytes(ini?.upload_max_filesize),
    phpSizeToBytes(ini?.post_max_size),
    64 * 1024 ** 2, // 64m floor — generous default, never shrink below it.
  );
  const bodyMb = Math.ceil(bodyBytes / 1024 ** 2);
  return `server {
    listen 80;
    server_name _;
    root /var/www/html;
    index index.php index.html;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    location ~ \\.php$ {
        try_files $fastcgi_script_name =404;
        fastcgi_pass ${fpmHost}:9000;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }
    client_max_body_size ${bodyMb}m;
}
`;
}

/**
 * Legacy constant kept for back-compat (default Apache, base pack). New deploys
 * use buildPhpDockerfile(). Equivalent to apache + no optional extensions.
 */
export const PHP_SITE_DOCKERFILE = buildPhpDockerfile({
  version: DEFAULT_PHP_VERSION,
  webServer: 'apache',
  extensions: [],
});
