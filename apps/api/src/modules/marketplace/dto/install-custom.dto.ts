import {
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsArray,
  Min,
  Max,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * A named docker volume mapped to an absolute in-container path:
 *   <volume-name>:/abs/container/path
 *
 * The host side MUST be a named volume (no "/", "~", ".", "..") so a
 * DEVELOPER can never bind-mount the host filesystem (e.g. "/:/host" or
 * "/var/run/docker.sock:..." => full host escape).
 */
export const SAFE_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** True if the string contains any C0 control char (incl. \n \r \t) or DEL. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a single "host:container" volume spec.
 * Returns an error string when unsafe, or null when it's a safe named mount.
 */
export function checkVolumeSafety(v: unknown): string | null {
  if (typeof v !== 'string') return 'volume must be a string';
  // Reject newlines / control chars outright — these enable compose-key
  // injection in the renderer (privileged, cap_add, pid:host, ...).
  if (hasControlChars(v)) return `volume contains control characters: "${v}"`;
  const idx = v.indexOf(':');
  if (idx <= 0) return `volume must be "<name>:/abs/container/path": "${v}"`;
  const host = v.slice(0, idx);
  const container = v.slice(idx + 1);
  // Host side: only a NAMED docker volume. Anything path-like = host escape.
  if (
    host.startsWith('/') ||
    host.startsWith('~') ||
    host.startsWith('.') ||
    host.includes('..') ||
    host.includes('/') ||
    !SAFE_VOLUME_NAME.test(host)
  ) {
    return `volume host side must be a named volume (got "${host}"): "${v}"`;
  }
  // Container side: must be an absolute in-container path. Strip a trailing
  // mode flag (":ro"/":rw") before checking.
  const containerPath = container.split(':')[0];
  if (!containerPath.startsWith('/') || containerPath.includes('..')) {
    return `volume container path must be absolute: "${v}"`;
  }
  return null;
}

@ValidatorConstraint({ name: 'safeVolumes', async: false })
export class SafeVolumesConstraint implements ValidatorConstraintInterface {
  private lastError = 'invalid volume';
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (!Array.isArray(value)) {
      this.lastError = 'volumes must be an array';
      return false;
    }
    for (const v of value) {
      const err = checkVolumeSafety(v);
      if (err) {
        this.lastError = err;
        return false;
      }
    }
    return true;
  }
  defaultMessage(_args: ValidationArguments): string {
    return this.lastError;
  }
}

/**
 * Body for POST /marketplace/install-custom — deploy any Docker Hub image.
 *
 * The user provides everything we'd otherwise read from a template:
 * the image reference, the port the container listens on, optional env
 * vars / volumes / command.
 */
export class InstallCustomDto {
  @ApiProperty({ description: 'Human-friendly app name (unique per project)' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Docker image (e.g. linuxserver/jellyfin:latest)' })
  @IsString()
  image: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty()
  @IsString()
  projectId: string;

  @ApiProperty({ description: 'Port the container listens on internally' })
  @IsNumber()
  @Min(1)
  @Max(65535)
  containerPort: number;

  @ApiProperty({ required: false, description: 'Host port (auto-picked if omitted)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(65535)
  hostPort?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  domainId?: string;

  @ApiProperty({ required: false, type: Object })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Volume mounts in "<named-volume>:/abs/container/path" form (e.g. media:/data). ' +
      'Host bind-mounts are rejected — only named volumes are allowed.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(SafeVolumesConstraint)
  volumes?: string[];

  @ApiProperty({ required: false, description: 'Override container CMD' })
  @IsOptional()
  @IsString()
  command?: string;
}
