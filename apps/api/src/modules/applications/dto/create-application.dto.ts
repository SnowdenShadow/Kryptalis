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

export class CreateApplicationDto {
  @ApiProperty({ example: 'my-app' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'clxyz...' })
  @IsString()
  projectId: string;

  @ApiProperty({ enum: AppFramework, example: AppFramework.DOCKER })
  @IsEnum(AppFramework)
  framework: AppFramework;

  @ApiProperty({ required: false, example: 'https://github.com/user/repo.git' })
  @IsOptional()
  @IsString()
  gitUrl?: string;

  @ApiProperty({ required: false, example: 'main' })
  @IsOptional()
  @IsString()
  gitBranch?: string;

  @ApiProperty({ required: false, enum: GitProviderType })
  @IsOptional()
  @IsEnum(GitProviderType)
  gitProvider?: GitProviderType;

  @ApiProperty({ required: false, example: 'node:20-alpine' })
  @IsOptional()
  @IsString()
  dockerImage?: string;

  @ApiProperty({ required: false, example: 'npm run build' })
  @IsOptional()
  @IsString()
  buildCommand?: string;

  @ApiProperty({ required: false, example: 'npm run start' })
  @IsOptional()
  @IsString()
  startCommand?: string;

  @ApiProperty({ required: false, example: 3000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiProperty({ required: false, example: { NODE_ENV: 'production' } })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiProperty({ required: false, description: 'ID of a connected git provider (private repo via OAuth)' })
  @IsOptional()
  @IsString()
  gitProviderId?: string;

  @ApiProperty({ required: false, description: 'One-shot personal access token for a private git URL (not stored)' })
  @IsOptional()
  @IsString()
  gitToken?: string;

  @ApiProperty({ required: false, description: 'Override docker-compose.yml content for first deploy' })
  @IsOptional()
  @IsString()
  composeOverride?: string;

  @ApiProperty({ required: false, description: 'Override Dockerfile content for first deploy' })
  @IsOptional()
  @IsString()
  dockerfileOverride?: string;

  @ApiProperty({ required: false, description: 'Host port mapping override { "containerPort": hostPort }' })
  @IsOptional()
  @IsObject()
  portMapping?: Record<string, number>;
}
