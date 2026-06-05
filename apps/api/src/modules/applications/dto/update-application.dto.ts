import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  IsObject,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AppFramework, GitProviderType } from '@prisma/client';

export class UpdateApplicationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, enum: AppFramework })
  @IsOptional()
  @IsEnum(AppFramework)
  framework?: AppFramework;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  gitUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  gitBranch?: string;

  @ApiProperty({ required: false, enum: GitProviderType })
  @IsOptional()
  @IsEnum(GitProviderType)
  gitProvider?: GitProviderType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  dockerImage?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  buildCommand?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  startCommand?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;
}
