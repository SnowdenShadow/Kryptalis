import {
  IsString,
  IsOptional,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsArray,
  Min,
  Max,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AppFramework, GitProviderType } from '@prisma/client';
import { SUPPORTED_PHP_VERSIONS, PHP_WEB_SERVERS } from '../php-site.constants';

export class CreateApplicationDto {
  @ApiProperty({ example: 'my-app' })
  @IsString()
  @MaxLength(64)
  // Defense-in-depth against Caddyfile + shell injection via the app name.
  // The reverse-proxy renderer also sanitizes at write time, but rejecting
  // bad input at the DTO boundary keeps DB rows trustworthy.
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, {
    message: 'name must start with a letter/digit and contain only A-Z, a-z, 0-9, space, dot, underscore, dash.',
  })
  name: string;

  @ApiProperty({ example: 'clxyz...' })
  @IsString()
  projectId: string;

  @ApiProperty({ enum: AppFramework, example: AppFramework.DOCKER })
  @IsEnum(AppFramework)
  framework: AppFramework;

  @ApiProperty({
    required: false,
    enum: SUPPORTED_PHP_VERSIONS as unknown as string[],
    example: '8.3',
    description: 'PHP runtime version — only for framework=PHP_SITE (Apache + mod_php).',
  })
  @IsOptional()
  @IsIn(SUPPORTED_PHP_VERSIONS as unknown as string[], {
    message: `phpVersion must be one of: ${SUPPORTED_PHP_VERSIONS.join(', ')}`,
  })
  phpVersion?: string;

  @ApiProperty({ required: false, enum: PHP_WEB_SERVERS as unknown as string[], description: 'PHP_SITE web server' })
  @IsOptional()
  @IsIn(PHP_WEB_SERVERS as unknown as string[])
  phpWebServer?: string;

  @ApiProperty({ required: false, type: [String], description: 'Optional PHP extensions to enable' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phpExtensions?: string[];

  @ApiProperty({ required: false, description: 'php.ini overrides (memory_limit, upload_max_filesize, …)' })
  @IsOptional()
  @IsObject()
  phpIni?: Record<string, string>;

  @ApiProperty({ required: false, description: 'PHP preset (wordpress|laravel|symfony|custom)' })
  @IsOptional()
  @IsString()
  phpPreset?: string;

  @ApiProperty({ required: false, example: 'https://github.com/user/repo.git' })
  @IsOptional()
  @IsString()
  gitUrl?: string;

  @ApiProperty({ required: false, example: 'main' })
  @IsOptional()
  @IsString()
  gitBranch?: string;

  @ApiProperty({ required: false, enum: GitProviderType })
  @IsOptional()
  @IsEnum(GitProviderType)
  gitProvider?: GitProviderType;

  @ApiProperty({ required: false, example: 'node:20-alpine' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  // Docker image reference grammar (simplified): optional registry host
  // + path segments + optional :tag or @sha256:digest. Rejects newlines,
  // spaces, YAML metacharacters — defense against compose injection when
  // we write the image into a generated docker-compose.yml.
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._\-:/@]{0,254}$/, {
    message: 'dockerImage must look like "[registry/]image[:tag|@sha256:...]"',
  })
  dockerImage?: string;

  @ApiProperty({ required: false, example: 'npm run build' })
  @IsOptional()
  @IsString()
  buildCommand?: string;

  @ApiProperty({ required: false, example: 'npm run start' })
  @IsOptional()
  @IsString()
  startCommand?: string;

  @ApiProperty({ required: false, example: 3000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiProperty({ required: false, example: { NODE_ENV: 'production' } })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiProperty({ required: false, description: 'ID of a connected git provider (private repo via OAuth)' })
  @IsOptional()
  @IsString()
  gitProviderId?: string;

  @ApiProperty({ required: false, description: 'One-shot personal access token for a private git URL (not stored)' })
  @IsOptional()
  @IsString()
  gitToken?: string;

  @ApiProperty({ required: false, description: 'Override docker-compose.yml content for first deploy' })
  @IsOptional()
  @IsString()
  composeOverride?: string;

  @ApiProperty({ required: false, description: 'Override Dockerfile content for first deploy' })
  @IsOptional()
  @IsString()
  dockerfileOverride?: string;

  @ApiProperty({ required: false, description: 'Raw docker-compose.yml — deploys a compose stack without a git repo.' })
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  composeContent?: string;

  @ApiProperty({ required: false, description: 'Raw Dockerfile — builds & deploys an image without a git repo.' })
  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  dockerfileContent?: string;

  @ApiProperty({ required: false, description: 'Build context files keyed by relative path (Dockerfile-only mode).' })
  @IsOptional()
  @IsObject()
  contextFiles?: Record<string, string>;

  @ApiProperty({ required: false, description: 'Host port mapping override { "containerPort": hostPort }' })
  @IsOptional()
  @IsObject()
  portMapping?: Record<string, number>;

  /**
   * Optional: attach the new app to this domain right after create. Goes
   * through DomainAttachService so multi-app-per-domain rules apply the
   * same way they do for marketplace installs.
   */
  @ApiProperty({ required: false, description: 'Domain to attach the app to once created' })
  @IsOptional()
  @IsString()
  domainId?: string;

  /**
   * Convenience: pass a brand-new domain string (e.g. "blog.acme.com")
   * and the backend creates the Domain row + attaches it atomically.
   * Saves the user a round-trip to the Domains page and avoids the
   * partial-failure window where the app exists but the domain create
   * 500s afterwards.
   */
  @ApiProperty({ required: false, description: 'New domain to create + attach in one go (e.g. "app.acme.com")' })
  @IsOptional()
  @IsString()
  @Matches(/^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/, {
    message: 'domain must be a valid RFC 1035 hostname (e.g. app.acme.com).',
  })
  domain?: string;

  /**
   * Optional: publish the container on this host port for direct
   * IP-based access (use when you have no domain). The platform refuses
   * ports already in use by DockControl system services or other apps.
   */
  @ApiProperty({ required: false, description: 'Host port to publish on (no domain case)' })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(65535)
  hostPort?: number;

  /**
   * Optional per-app server placement (MULTI mode). Omit to inherit the
   * project's default server. Must reference an ONLINE server.
   */
  @ApiProperty({ required: false, description: 'Server to deploy this app on (defaults to the project server)' })
  @IsOptional()
  @IsString()
  serverId?: string;

  /**
   * INTERNAL — not part of the public API. Set only by in-process callers
   * (ProjectTransferService), never by a client. Carries docker-volume seeds
   * (key + on-disk tar path) that runComposeOnlyDeploy restores BEFORE the
   * stack boots, so an imported bundled-DB app starts on its restored datadir.
   * compose-only deploys only.
   *
   * MUST be `declare`: under target ES2022 (useDefineForClassFields), a plain
   * field declaration emits a real instance property initialised to `undefined`
   * — which the global ValidationPipe's `forbidNonWhitelisted` then rejects on
   * EVERY create request ("property restoreVolumes should not exist"), even
   * when the client never sent it. `declare` makes it type-only (no emit), so
   * the property is genuinely absent unless an in-process caller assigns it.
   */
  declare restoreVolumes?: { key: string; tarPath: string }[];

  /**
   * INTERNAL — same in-process-only contract as restoreVolumes above (and the
   * same `declare` requirement for the same ES2022 reason). Carries a
   * `docker save` tar (on-disk path) + the exact image tags it holds.
   * runComposeOnlyDeploy `docker load`s it and rewrites the compose to consume
   * the loaded images (build:→image:, pull_policy: missing) BEFORE `up`, so the
   * imported stack runs the EXACT same image with no pull/rebuild. compose-only
   * deploys only.
   */
  declare loadImages?: { tarPath: string; tags: string[] };
}
