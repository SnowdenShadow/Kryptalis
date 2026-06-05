import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TriggerDeploymentDto {
  @ApiProperty()
  @IsString()
  applicationId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  commitSha?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
