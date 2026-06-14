import { IsString, IsOptional, IsIn, IsBoolean, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ApplyImportDto {
  @ApiProperty({ description: 'Staging id returned by the parse step.' })
  @IsString()
  @Matches(/^xfer_[a-z0-9_]+$/, { message: 'Invalid import id.' })
  stagedId!: string;

  @ApiProperty({ description: 'Same passphrase used at export (to decrypt per-app secrets).' })
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  passphrase!: string;

  @ApiProperty({ required: false, description: 'Target server (MULTI mode).' })
  @IsOptional()
  @IsString()
  targetServerId?: string;

  @ApiProperty({ required: false, enum: ['skip', 'attach'], description: 'What to do with the archive’s domains.' })
  @IsOptional()
  @IsIn(['skip', 'attach'])
  domainStrategy?: 'skip' | 'attach';

  @ApiProperty({
    required: false,
    description:
      'Explicit consent to import apps that take full host control (docker socket / host bind-mounts). ' +
      'Off by default — only set true for an archive you created or fully trust.',
  })
  @IsOptional()
  @IsBoolean()
  allowHostAccess?: boolean;
}
