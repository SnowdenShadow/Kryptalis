import { IsString, IsNumber, IsOptional, IsIn, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAlertRuleDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty({ enum: ['cpu', 'memory', 'disk'] })
  @IsIn(['cpu', 'memory', 'disk'])
  metric: string;

  @ApiProperty({ example: 90 })
  @IsNumber()
  threshold: number;

  @ApiProperty({ enum: ['GT', 'GTE', 'LT', 'LTE', 'EQ'], default: 'GTE', required: false })
  @IsOptional()
  @IsIn(['GT', 'GTE', 'LT', 'LTE', 'EQ'])
  operator?: string;

  @ApiProperty({ enum: ['EMAIL', 'DISCORD', 'SLACK', 'WEBHOOK'] })
  @IsIn(['EMAIL', 'DISCORD', 'SLACK', 'WEBHOOK'])
  channel: string;

  @ApiProperty({ required: false })
  @IsOptional()
  // Require an absolute http(s) URL. The service layer additionally screens
  // the resolved host against private/loopback/metadata ranges (SSRF) — a
  // syntactically valid URL is necessary but not sufficient.
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  webhookUrl?: string;
}
