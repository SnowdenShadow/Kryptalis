import * as yaml from 'js-yaml';
import { checkVolumeSafety } from '../marketplace/dto/install-custom.dto';

/**
 * Validate a docker-compose document that arrived in an UNTRUSTED `.dctproj`
 * archive from another install. An imported compose is attacker-controlled, so
 * — exactly like the custom-marketplace install path — it must be screened for
 * host escapes BEFORE it is ever written to disk and run with `docker compose
 * up`. The normal create() compose check only verifies it parses + has a
 * `services:` map; it does NOT reject bind-mounts or privileged primitives, so
 * the import path adds this dedicated guard.
 *
 * Rejects, per service:
 *   - host bind-mount volumes (anything but a named-volume:/abs mapping),
 *     including the docker socket — via the shared checkVolumeSafety();
 *   - privileged: true
 *   - cap_add (any)
 *   - network_mode: host  (and pid/ipc/uts: host)
 *   - devices (host device passthrough)
 *   - user-defined volumes whose `driver_opts` bind to a host path
 *
 * Returns an array of human-readable problems (empty = safe).
 */
export function checkImportedComposeSafety(composeYaml: string | null | undefined): string[] {
  if (!composeYaml || typeof composeYaml !== 'string') return [];
  let doc: any;
  try {
    doc = yaml.load(composeYaml);
  } catch (e: any) {
    return [`compose is not valid YAML: ${e?.message || e}`];
  }
  if (!doc || typeof doc !== 'object') return ['compose must be a YAML mapping'];

  const problems: string[] = [];
  const services = doc.services;
  if (!services || typeof services !== 'object') {
    return ['compose must declare a top-level "services:" map'];
  }

  for (const [name, svcRaw] of Object.entries(services)) {
    const svc: any = svcRaw;
    if (!svc || typeof svc !== 'object') continue;
    const at = (msg: string) => `service "${name}": ${msg}`;

    // Volumes — reuse the exact host-escape screen the custom-install uses.
    if (Array.isArray(svc.volumes)) {
      for (const v of svc.volumes) {
        if (typeof v === 'string') {
          const err = checkVolumeSafety(v);
          if (err) problems.push(at(err));
        } else if (v && typeof v === 'object') {
          // Long-form: { type: bind, source: /host, target: /x }
          if (v.type === 'bind') problems.push(at(`host bind mount is not allowed (source "${v.source}")`));
          // Long-form named volume is fine.
        }
      }
    }

    if (svc.privileged === true) problems.push(at('privileged: true is not allowed'));
    if (svc.cap_add !== undefined) problems.push(at('cap_add is not allowed'));
    if (svc.devices !== undefined) problems.push(at('host devices are not allowed'));
    if (svc.device_cgroup_rules !== undefined) problems.push(at('device_cgroup_rules is not allowed'));
    for (const ns of ['network_mode', 'pid', 'ipc', 'uts', 'userns_mode', 'cgroup'] as const) {
      const val = svc[ns];
      if (typeof val === 'string' && /(^|:)host$/.test(val)) {
        problems.push(at(`${ns}: ${val} is not allowed`));
      }
    }
    // security_opt that disables the sandbox (apparmor/seccomp unconfined,
    // no-new-privileges:false) is a container-hardening downgrade — refuse it.
    if (Array.isArray(svc.security_opt)) {
      for (const opt of svc.security_opt) {
        if (typeof opt === 'string' && /unconfined|no-new-privileges\s*[:=]\s*false/i.test(opt)) {
          problems.push(at(`security_opt "${opt}" is not allowed`));
        }
      }
    }
  }

  // Top-level named volumes that bind to a host path via driver_opts.
  const vols = doc.volumes;
  if (vols && typeof vols === 'object') {
    for (const [vname, vdefRaw] of Object.entries(vols)) {
      const vdef: any = vdefRaw;
      const opts = vdef?.driver_opts;
      if (opts && (opts.type === 'none' || opts.o === 'bind' || (typeof opts.device === 'string' && opts.device.startsWith('/')))) {
        problems.push(`volume "${vname}": host-path bind via driver_opts is not allowed`);
      }
    }
  }

  return problems;
}
