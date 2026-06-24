import * as path from 'path';

/**
 * Single source of truth for the on-disk runtime layout.
 *
 * Before this module, the line
 *   `const DATA_DIR = process.env.DOCKCONTROL_DATA_DIR || path.join(process.cwd(), '.dockcontrol')`
 * was copy-pasted verbatim across ~9 services, and the `databases/` subdir was
 * derived independently by both DatabasesService and ProjectsService — so any
 * change to the runtime root (or a typo) had to be fixed in every copy.
 *
 * Everything DockControl persists on the host lives under DATA_DIR (the
 * `.dockcontrol/` dir, bind-mounted into the API container at /app/.dockcontrol
 * and into Caddy/SFTP for the slices they need). DOCKCONTROL_DATA_DIR is set in
 * docker-compose.yml to that in-container path; the cwd fallback only covers a
 * single-process `pnpm dev` run from the API package root.
 *
 * NOTE: the host layout is unchanged — these are the same paths the old
 * per-service constants produced. This module only removes the duplication.
 */
export const DATA_DIR =
  process.env.DOCKCONTROL_DATA_DIR || path.join(process.cwd(), '.dockcontrol');

/** Per-app generated stacks: .dockcontrol/apps/<slug>-<id12>/ */
export const APPS_DIR = path.join(DATA_DIR, 'apps');
/** Standalone managed databases: .dockcontrol/databases/<name>/ */
export const DBS_DIR = path.join(DATA_DIR, 'databases');
/** Encrypted backup artifacts. */
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
/** Mail server stacks (docker-mailserver) per server. */
export const MAIL_DIR = path.join(DATA_DIR, 'mail');
/** Caddyfile + cert-reload bookkeeping (also mounted RO into Caddy). */
export const PROXY_DIR = path.join(DATA_DIR, 'reverse-proxy');
/** Cross-install project-transfer staging (.dctproj export/import). */
export const XFER_DIR = path.join(DATA_DIR, 'project-transfer');
/** Agent volume-transfer staging. */
export const TRANSFERS_DIR = path.join(DATA_DIR, 'transfers');
/** Scratch space for file uploads before they're moved into place. */
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
