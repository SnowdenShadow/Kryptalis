import { IsString, IsOptional, IsObject, IsInt, Matches, MaxLength, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
  envVars?: Record<string, string>;
}
