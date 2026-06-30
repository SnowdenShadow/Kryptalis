import { IsString, IsOptional, IsObject, IsInt, Matches, MaxLength, Min, Max, Validate } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SafeEnvVarsConstraint } from './install-custom.dto';

export class InstallAppDto {
  @ApiProperty()
  @IsString()
  appSlug: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  serverId?: string;

  @ApiProperty()
  @IsString()
  projectId: string;

  @ApiProperty({ required: false, description: 'Custom name for this instance (slug)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  domainId?: string;

  @ApiProperty({ required: false, description: 'New domain to create + attach' })
  @IsOptional()
  @IsString()
  @Matches(/^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/, {
    message: 'newDomain must be a valid hostname (e.g. app.acme.com).',
  })
  newDomain?: string;

  @ApiProperty({ required: false, description: 'Publish on this host port for direct IP access' })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(65535)
  hostPort?: number;

  @ApiProperty({
    required: false,
    description: 'Legacy alias of hostPort — custom HOST port for the install (template default if absent)',
  })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(65535)
  port?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  // M-2: validate env-var KEYS. The install path writes these to the per-instance
  // .env; a key containing a newline could inject extra KEY=VALUE lines (override
  // ${VAR:-default} substitutions the template relies on, e.g. a DB password).
  // Same guard the custom-image install (InstallCustomDto) already applies.
  @Validate(SafeEnvVarsConstraint)
  envVars?: Record<string, string>;

  @ApiProperty({
    required: false,
    description: 'php.ini overrides for PHP marketplace apps (memory_limit, short_open_tag, …). Ignored for non-PHP apps.',
  })
  @IsOptional()
  @IsObject()
  phpIni?: Record<string, string>;
}
