import { IsString, IsNumber, IsObject, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class HeartbeatContainerDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  state: string;
}

export class AgentHeartbeatDto {
  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty()
  @IsString()
  token: string;

  @ApiProperty()
  @IsString()
  agentVersion: string;

  @ApiProperty()
  @IsString()
  os: string;

  @ApiProperty()
  @IsString()
  arch: string;

  @ApiProperty()
  @IsNumber()
  uptime: number;

  @ApiProperty()
  @IsObject()
  metrics: {
    cpuPercent: number;
    memoryUsed: number;
    memoryTotal: number;
    diskUsed: number;
    diskTotal: number;
  };

  /** Live kryptalis-* container states (agents ≥ the status-sync release). */
  @ApiProperty({ required: false, type: [HeartbeatContainerDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HeartbeatContainerDto)
  containers?: HeartbeatContainerDto[];
}
