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
