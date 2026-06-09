import {
  IsString,
  IsOptional,
  IsArray,
  IsBoolean,
  IsIn,
  IsDateString,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
// allowShell is on both create + update DTOs — declared after the
// import block so we don't reshuffle the original ones.
import { ApiProperty } from '@nestjs/swagger';
import type { SftpPermission } from '@prisma/client';

export class CreateSftpAccountDto {
  @ApiProperty({ enum: ['app', 'project'] })
  @IsIn(['app', 'project'])
  scope: 'app' | 'project';

  @ApiProperty({ description: 'Application id or Project id' })
  @IsString()
  scopeId: string;

  @ApiProperty({ example: 'ftp_user', description: 'lowercase a-z 0-9 _ -, starts with a letter, 3-32 chars' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]{2,31}$/, {
    message: 'username must be lowercase, 3-32 chars, start with a letter, only a-z 0-9 _ -',
  })
  username: string;

  @ApiProperty({ required: false, description: 'If omitted or empty, a strong password is auto-generated.' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;

  @ApiProperty({ required: false, type: [String], description: 'SSH authorized_keys entries' })
  @IsOptional()
  @IsArray()
  publicKeys?: string[];

  @ApiProperty({ required: false, enum: ['READ', 'WRITE', 'ADMIN'] })
  @IsOptional()
  @IsIn(['READ', 'WRITE', 'ADMIN'])
  permission?: SftpPermission;

  @ApiProperty({ required: false, description: 'ISO date — account auto-disables past this' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({ required: false, description: 'When true, the account can open an interactive SSH shell (still chrooted to the app sandbox). Default false = SFTP only.' })
  @IsOptional()
  @IsBoolean()
  allowShell?: boolean;
}

export class UpdateSftpAccountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;

  @ApiProperty({ required: false, enum: ['READ', 'WRITE', 'ADMIN'] })
  @IsOptional()
  @IsIn(['READ', 'WRITE', 'ADMIN'])
  permission?: SftpPermission;

  @ApiProperty({ required: false, description: 'Pass null to remove the expiry.' })
  @IsOptional()
  expiresAt?: string | null;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  publicKeys?: string[];

  @ApiProperty({ required: false, description: 'Toggle interactive shell access' })
  @IsOptional()
  @IsBoolean()
  allowShell?: boolean;
}
