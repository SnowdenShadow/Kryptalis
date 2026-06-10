import * as path from 'path';
import { slugify, resolveAppDir } from '../applications/applications.helpers';

/**
 * Deterministic docker-volume naming for Kryptalis-managed compose stacks.
 *
 * Compose names volumes `<project>_<volume>` where the project name is the
 * compose dir basename:
 *   - applications: basename(resolveAppDir(slugify(name), id)) — i.e. the
 *     per-instance `<slug>-<id12>` dir (or the legacy `<slug>` dir when it
 *     exists locally);
 *   - databases (manually provisioned): DBS_DIR/<db.name> → `<db.name>`,
 *     and every generated database compose declares exactly one volume
 *     named `data`.
 *
 * This is how we build volume lists for REMOTE servers, where we cannot run
 * `docker volume ls` from the API process. LIMITATION (documented on every
 * caller): only volumes following the `<composeProject>_data` convention are
 * enumerable this way — stacks declaring differently-named or multiple
 * volumes (e.g. marketplace templates with `<x>_data_<instanceId>` keys, or
 * user-authored compose files) are NOT covered by the deterministic list.
 * When the host is local, callers should prefer prefix-filtering the real
 * `docker volume ls` output instead (covers every volume of the stack).
 */

/** Compose-project volume prefix for an application (`<project>_`). */
export function appVolumePrefix(appName: string, applicationId: string): string {
  return `${path.basename(resolveAppDir(slugify(appName), applicationId))}_`;
}

/** Compose-project volume prefix for a manually-provisioned database. */
export function dbVolumePrefix(dbName: string): string {
  return `${dbName}_`;
}

/**
 * Best-effort deterministic volume names for a set of apps + databases on a
 * server we cannot run docker against. See the file header for coverage
 * limits. Auto-imported databases ride their parent app's compose stack and
 * are therefore covered (to the extent possible) by the app entry.
 */
export function deterministicVolumeNames(
  apps: Array<{ id: string; name: string }>,
  databases: Array<{ name: string; autoImported?: boolean }>,
): string[] {
  const names = new Set<string>();
  for (const app of apps) {
    names.add(`${appVolumePrefix(app.name, app.id)}data`);
  }
  for (const db of databases) {
    if (db.autoImported) continue; // lives in the parent app's stack
    names.add(`${dbVolumePrefix(db.name)}data`);
  }
  return Array.from(names);
}
