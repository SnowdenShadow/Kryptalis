import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDomainDto {
  @ApiProperty({ example: 'app.example.com' })
  @IsString()
  domain: string;

  @ApiProperty({ description: 'Project owning this domain (required — mail-only domains too)' })
  @IsString()
  projectId: string;

  @ApiProperty({ required: false, description: 'Optional — link to a web app for HTTP routing' })
  @IsOptional()
  @IsString()
  applicationId?: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  autoSsl?: boolean;
}
