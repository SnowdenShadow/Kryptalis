import { IsString, IsBoolean, IsOptional, IsNotEmpty, MaxLength, Validate } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsCronConstraint } from './create-cron-job.dto';

export class UpdateCronJobDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

  @ApiProperty({ required: false, example: '0 3 * * *' })
  @IsOptional()
  @IsString()
  @Validate(IsCronConstraint)
  schedule?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  command?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
