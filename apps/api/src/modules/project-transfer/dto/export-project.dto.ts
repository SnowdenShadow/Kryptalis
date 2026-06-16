import { IsBoolean, IsOptional, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExportProjectDto {
  @ApiProperty({ description: 'Include database dumps + docker volumes (heavier archive).' })
  @IsOptional()
  @IsBoolean()
  includeData?: boolean;

  @ApiProperty({
    description:
      'Bundle each app\'s Docker images (docker save) so import runs the EXACT same image — no pull, no rebuild. Much heavier archive (GBs).',
  })
  @IsOptional()
  @IsBoolean()
  includeImages?: boolean;

  @ApiProperty({ description: 'Passphrase used to encrypt the archive — required again on import.' })
  @IsString()
  @MinLength(12, { message: 'Passphrase must be at least 12 characters.' })
  @MaxLength(256)
  passphrase!: string;
}
