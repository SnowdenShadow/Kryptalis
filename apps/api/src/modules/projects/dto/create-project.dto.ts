import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({ example: 'My Project' })
  @IsString()
  name: string;

  @ApiProperty({ required: false, example: 'A cool project' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'clxyz...' })
  @IsString()
  serverId: string;
}
