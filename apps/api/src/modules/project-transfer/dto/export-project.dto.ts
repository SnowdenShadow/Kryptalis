import { IsBoolean, IsOptional, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExportProjectDto {
  @ApiProperty({ description: 'Include database dumps + docker volumes (heavier archive).' })
  @IsOptional()
  @IsBoolean()
  includeData?: boolean;

  @ApiProperty({ description: 'Passphrase used to encrypt the archive — required again on import.' })
  @IsString()
  @MinLength(12, { message: 'Passphrase must be at least 12 characters.' })
  @MaxLength(256)
  passphrase!: string;
}
