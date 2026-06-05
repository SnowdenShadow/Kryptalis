import { IsString, IsOptional, IsObject, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TaskResultDto {
  @ApiProperty({ enum: ['COMPLETED', 'FAILED'] })
  @IsIn(['COMPLETED', 'FAILED'])
  status: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  error?: string;
}
