import { IsOptional, IsIn, IsBoolean, IsNumber, Min, Max, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Antispam config for a mail server. A `preset` expands to concrete settings;
 * 'custom' (or omitting preset) keeps the posted individual values. The
 * white/black lists are newline-separated senders/domains (validated +
 * filtered server-side before they reach the rspamd map).
 */
export class UpdateAntispamDto {
  @ApiProperty({ required: false, enum: ['standard', 'strict', 'maximum', 'custom'] })
  @IsOptional()
  @IsIn(['standard', 'strict', 'maximum', 'custom'])
  preset?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  greylisting?: boolean;

  @ApiProperty({ required: false, description: 'ClamAV antivirus (heavy — ~1GB RAM)' })
  @IsOptional()
  @IsBoolean()
  antivirus?: boolean;

  @ApiProperty({ required: false, enum: ['add_header', 'reject'] })
  @IsOptional()
  @IsIn(['add_header', 'reject'])
  spamAction?: string;

  @ApiProperty({ required: false, description: 'rspamd reject score (1-15; lower = stricter)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(15)
  spamThreshold?: number;

  @ApiProperty({ required: false, description: 'Allowed senders/domains, one per line' })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  whitelist?: string;

  @ApiProperty({ required: false, description: 'Blocked senders/domains, one per line' })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  blacklist?: string;
}
