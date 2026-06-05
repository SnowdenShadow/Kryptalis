import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AgentPollDto {
  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty()
  @IsString()
  token: string;
}
