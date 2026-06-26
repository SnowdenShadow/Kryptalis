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
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AppFramework, GitProviderType } from '@prisma/client';
import { SUPPORTED_PHP_VERSIONS, PHP_WEB_SERVERS } from '../php-site.constants';

export class UpdateApplicationDto {
  // Note: `name` is intentionally NOT exposed here. It's the slug source and
  // changing it would break the container, on-disk dir, and Caddy bindings.
  // Use `displayName` to rename for UI purposes only.

  @ApiProperty({ required: false, description: 'Cosmetic name shown in the UI. Slug, container, and paths are unaffected.' })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({ required: false, enum: AppFramework })
  @IsOptional()
  @IsEnum(AppFramework)
  framework?: AppFramework;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  gitUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  gitBranch?: string;

  @ApiProperty({ required: false, enum: GitProviderType })
  @IsOptional()
  @IsEnum(GitProviderType)
  gitProvider?: GitProviderType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  dockerImage?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  buildCommand?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  startCommand?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiProperty({
    required: false,
    enum: SUPPORTED_PHP_VERSIONS as unknown as string[],
    description: 'Change a PHP_SITE app\'s PHP version — triggers an image rebuild + redeploy.',
  })
  @IsOptional()
  @IsIn(SUPPORTED_PHP_VERSIONS as unknown as string[], {
    message: `phpVersion must be one of: ${SUPPORTED_PHP_VERSIONS.join(', ')}`,
  })
  phpVersion?: string;

  @ApiProperty({ required: false, enum: PHP_WEB_SERVERS as unknown as string[], description: 'PHP_SITE web server — triggers a redeploy.' })
  @IsOptional()
  @IsIn(PHP_WEB_SERVERS as unknown as string[])
  phpWebServer?: string;

  @ApiProperty({ required: false, type: [String], description: 'Optional PHP extensions — triggers a redeploy.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phpExtensions?: string[];

  @ApiProperty({ required: false, description: 'php.ini overrides — triggers a redeploy.' })
  @IsOptional()
  @IsObject()
  phpIni?: Record<string, string>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phpPreset?: string;
}
