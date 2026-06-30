import { BadRequestException } from '@nestjs/common';
import { checkImportedComposeSafety } from '../../modules/project-transfer/dctproj-compose-guard';

/**
 * Shared host-escape screen for ANY user-supplied docker-compose document,
 * wherever it enters the platform.
 *
 * `checkImportedComposeSafety` was originally written for the `.dctproj`
 * import path, but the exact same threat applies to every compose body a
 * tenant can submit through the applications module — raw `composeContent`,
 * a git-deploy `composeOverride`, and the compose-file editor
 * (`PATCH /applications/:id/files/compose`). All of those previously only
 * checked that the YAML parsed and had a `services:` map, which does NOT stop
 * `privileged: true`, `cap_add`, `pid: host`, a `/var/run/docker.sock` or
 * `/:/host` bind-mount, etc. — a project DEVELOPER could therefore escape to
 * host root. This helper is the single choke point that closes that gap; call
 * it before any user compose is written to disk and run with `docker compose
 * up`.
 *
 * Re-exports the underlying checker so callers that want the raw problem list
 * (e.g. to compute a `requiresHostAccess` flag instead of rejecting) can keep
 * using it directly.
 */
export { checkImportedComposeSafety } from '../../modules/project-transfer/dctproj-compose-guard';

/**
 * Throw a 400 if `composeYaml` contains any host-escape primitive. No-op for
 * empty/undefined input (callers gate on "is there a compose at all" first).
 */
export function assertComposeSafe(composeYaml: string | null | undefined): void {
  const problems = checkImportedComposeSafety(composeYaml);
  if (problems.length > 0) {
    throw new BadRequestException(
      `Unsafe docker-compose — host-escape primitives are not allowed: ${problems.join('; ')}`,
    );
  }
}
