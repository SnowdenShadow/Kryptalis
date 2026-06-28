/**
 * Shared validation for the file-manager permission ops (chmod / chown).
 *
 * These run on a host (or in a container) that has root-equivalent control of
 * the docker daemon, so the validation here is a SECURITY boundary:
 *  - chmod: only the 9 standard rwx bits are allowed. setuid/setgid/sticky
 *    (anything outside 0o777) is REFUSED — a setuid binary in a root-equivalent
 *    context is a privilege-escalation primitive.
 *  - chown: the owner spec is constrained to a strict `user[:group]` / numeric
 *    form so it can be passed as a single argv token (never a shell string).
 */
import { BadRequestException } from '@nestjs/common';

/**
 * Parse + validate an octal mode string/number to an integer in [0, 0o777].
 * Accepts '755', '0775', 493 (=0o755). Rejects anything with bits outside the
 * low 9 (setuid 0o4000 / setgid 0o2000 / sticky 0o1000) and out-of-range values.
 */
export function parseChmodMode(input: string | number): number {
  let mode: number;
  if (typeof input === 'number') {
    mode = input;
  } else if (typeof input === 'string' && /^[0-7]{3,4}$/.test(input.trim())) {
    mode = parseInt(input.trim(), 8);
  } else {
    throw new BadRequestException('mode must be an octal string like "755" or a number');
  }
  if (!Number.isInteger(mode) || mode < 0) {
    throw new BadRequestException('invalid mode');
  }
  if ((mode & ~0o777) !== 0) {
    // setuid/setgid/sticky or out of range.
    throw new BadRequestException('mode must be within 0000–0777 (setuid/setgid/sticky not allowed)');
  }
  return mode;
}

// A POSIX user/group name: starts with a letter or underscore, then
// letters/digits/_/- , max 32 chars (Linux NAME_MAX for accounts is 32).
const NAME = '[a-z_][a-z0-9_-]{0,31}';
const OWNER_NAME_RE = new RegExp(`^${NAME}(:${NAME})?$`);
// Numeric uid[:gid], each up to 7 digits.
const OWNER_NUM_RE = /^\d{1,7}(:\d{1,7})?$/;

export interface OwnerSpec {
  raw: string; // the validated "user:group" token (safe as a single argv)
  numeric: boolean; // true when both sides are numeric (LOCAL-mode safe)
  uid?: number;
  gid?: number;
}

/**
 * Validate a chown owner spec. Accepts either a numeric `uid[:gid]` (allowed in
 * every mode, including LOCAL host-fs) or a `name[:name]` (allowed only where a
 * `chown` binary resolves names — i.e. inside the container / on the agent).
 * Throws on anything that could smuggle shell metacharacters or whitespace.
 */
export function parseChownOwner(input: string): OwnerSpec {
  if (typeof input !== 'string') throw new BadRequestException('owner is required');
  const raw = input.trim();
  if (!raw) throw new BadRequestException('owner is required');
  if (raw.length > 65) throw new BadRequestException('owner too long');
  if (OWNER_NUM_RE.test(raw)) {
    const [u, g] = raw.split(':');
    return { raw, numeric: true, uid: parseInt(u, 10), gid: g !== undefined ? parseInt(g, 10) : undefined };
  }
  if (OWNER_NAME_RE.test(raw)) {
    return { raw, numeric: false };
  }
  throw new BadRequestException(
    'owner must be "user", "user:group", or numeric "uid[:gid]" (no spaces or special characters)',
  );
}
