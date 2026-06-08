import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  IsObject,
  Min,
  Max,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AppFramework, GitProviderType } from '@prisma/client';

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
}
