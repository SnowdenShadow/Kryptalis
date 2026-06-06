import {
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsArray,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /marketplace/install-custom — deploy any Docker Hub image.
 *
 * The user provides everything we'd otherwise read from a template:
 * the image reference, the port the container listens on, optional env
 * vars / volumes / command.
 */
export class InstallCustomDto {
  @ApiProperty({ description: 'Human-friendly app name (unique per project)' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Docker image (e.g. linuxserver/jellyfin:latest)' })
  @IsString()
  image: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty()
  @IsString()
  projectId: string;

  @ApiProperty({ description: 'Port the container listens on internally' })
  @IsNumber()
  @Min(1)
  @Max(65535)
  containerPort: number;

  @ApiProperty({ required: false, description: 'Host port (auto-picked if omitted)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(65535)
  hostPort?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  domainId?: string;

  @ApiProperty({ required: false, type: Object })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Volume mounts in "host:container" form (e.g. /data/foo:/app/data)',
  })
  @IsOptional()
  @IsArray()
  volumes?: string[];

  @ApiProperty({ required: false, description: 'Override container CMD' })
  @IsOptional()
  @IsString()
  command?: string;
}
