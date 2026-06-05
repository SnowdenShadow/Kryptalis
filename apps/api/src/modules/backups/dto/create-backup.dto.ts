import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBackupDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty({ enum: ['LOCAL', 'S3', 'R2', 'B2'] })
  @IsIn(['LOCAL', 'S3', 'R2', 'B2'])
  target: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  includeApplications?: boolean;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  includeDatabases?: boolean;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  includeVolumes?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  schedule?: string;
}
