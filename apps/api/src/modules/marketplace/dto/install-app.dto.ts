import { IsString, IsOptional, IsObject, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InstallAppDto {
  @ApiProperty()
  @IsString()
  appSlug: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty()
  @IsString()
  projectId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  domainId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  port?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;
}
