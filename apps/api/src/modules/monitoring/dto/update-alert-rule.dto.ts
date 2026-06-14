import { IsNumber, IsOptional, IsIn, IsBoolean, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * PATCH /monitoring/alert-rules/:id body. Every field is optional (partial
 * update) but each present field is validated — previously the controller
 * took a raw inline `@Body()` with NO validation, so an attacker could PATCH
 * `webhookUrl` to an internal target or set a bogus metric/operator. The
 * service layer still SSRF-screens webhookUrl on dispatch; this DTO stops
 * the obviously-malformed values at the edge.
 */
export class UpdateAlertRuleDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ enum: ['cpu', 'memory', 'disk'], required: false })
  @IsOptional()
  @IsIn(['cpu', 'memory', 'disk'])
  metric?: string;

  @ApiProperty({ example: 90, required: false })
  @IsOptional()
  @IsNumber()
  threshold?: number;

  @ApiProperty({ enum: ['GT', 'GTE', 'LT', 'LTE', 'EQ'], required: false })
  @IsOptional()
  @IsIn(['GT', 'GTE', 'LT', 'LTE', 'EQ'])
  operator?: string;

  @ApiProperty({ enum: ['EMAIL', 'DISCORD', 'SLACK', 'WEBHOOK'], required: false })
  @IsOptional()
  @IsIn(['EMAIL', 'DISCORD', 'SLACK', 'WEBHOOK'])
  channel?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  webhookUrl?: string;
}
