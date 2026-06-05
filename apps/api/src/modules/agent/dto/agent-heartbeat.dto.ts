import { IsString, IsNumber, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
}
