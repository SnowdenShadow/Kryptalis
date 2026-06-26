/**
 * Supported PHP runtime versions for the PHP_SITE hosting type. Each maps to an
 * official `php:<version>-apache` Docker image tag (Debian-based, mod_php).
 *
 * Ordered newest-first so the UI dropdown defaults to the most current release.
 * Keep this list in sync with the tags Docker Hub still publishes — dropping an
 * EOL tag here stops new sites using it without touching existing deploys.
 */
export const SUPPORTED_PHP_VERSIONS = ['8.3', '8.2', '8.1', '8.0', '7.4'] as const;

export type PhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

/** Default chosen when the user doesn't pick one (latest stable). */
export const DEFAULT_PHP_VERSION: PhpVersion = '8.3';

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
}
export const PHP_INI_KEYS: (keyof PhpIniSettings)[] = [
  'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'timezone',
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
function sanitizePhpIni(ini: Record<string, unknown> | null | undefined): PhpIniSettings {
  const out: PhpIniSettings = {};
  if (!ini) return out;
  for (const k of PHP_INI_KEYS) {
    const v = cleanIniValue((ini as any)[k]);
    if (v) (out as any)[k] = v;
  }
  return out;
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
  const version = isSupportedPhpVersion(args.version) ? args.version : DEFAULT_PHP_VERSION;
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
  const out: string[] = ['; Generated by DockControl — PHP_SITE overrides.'];
  if (ini?.memory_limit) out.push(`memory_limit = ${ini.memory_limit}`);
  if (ini?.upload_max_filesize) out.push(`upload_max_filesize = ${ini.upload_max_filesize}`);
  if (ini?.post_max_size) out.push(`post_max_size = ${ini.post_max_size}`);
  if (ini?.max_execution_time) out.push(`max_execution_time = ${ini.max_execution_time}`);
  if (ini?.timezone) out.push(`date.timezone = ${ini.timezone}`);
  return out.join('\n') + '\n';
}

/** Nginx site config used in nginx mode — serves the docroot, FastCGI to php-fpm. */
export function buildNginxConf(): string {
  return `server {
    listen 80;
    server_name _;
    root /var/www/html;
    index index.php index.html;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    location ~ \\.php$ {
        fastcgi_pass app:9000;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }
    client_max_body_size 64m;
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
