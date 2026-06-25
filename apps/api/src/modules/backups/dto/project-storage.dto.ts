import { IsString, IsOptional, IsIn, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { REMOTE_TARGETS } from '../backup-storage.util';

/**
 * Per-project remote backup storage config. `secretKey` is optional on update:
 * left empty/omitted keeps the existing stored secret (same UX contract as the
 * admin SMTP/S3 config — never re-show a secret, never wipe it accidentally).
 */
export class SetProjectStorageDto {
  @ApiProperty({ enum: REMOTE_TARGETS as unknown as string[], example: 'R2' })
  @IsIn(REMOTE_TARGETS as unknown as string[], {
    message: `target must be one of: ${REMOTE_TARGETS.join(', ')}`,
  })
  target: string;

  @ApiProperty({ example: 'https://<accountid>.r2.cloudflarestorage.com' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  // Endpoint is interpolated into the S3 client config — keep it a plain URL,
  // no whitespace/control chars.
  @Matches(/^https?:\/\/[^\s]+$/i, { message: 'endpoint must be an http(s) URL' })
  endpoint: string;

  @ApiProperty({ example: 'my-backups' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  bucket: string;

  @ApiProperty({ required: false, example: 'auto' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ApiProperty({ example: 'AKIA...' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  accessKey: string;

  @ApiProperty({ required: false, description: 'Leave empty to keep the existing secret.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  secretKey?: string;
}
