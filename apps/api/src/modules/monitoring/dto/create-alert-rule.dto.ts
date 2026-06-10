import { IsString, IsNumber, IsOptional, IsIn } from 'class-validator';
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
  @IsString()
  webhookUrl?: string;
}
