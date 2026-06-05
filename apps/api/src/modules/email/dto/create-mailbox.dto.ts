import { IsString, IsOptional, IsInt, Min, Max, IsBoolean, IsEmail, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateMailboxDto {
  @ApiProperty({ example: 'contact', description: 'Local part of the email address' })
  @IsString()
  @Matches(/^[a-z0-9._-]+$/i, { message: 'localPart can only contain letters, digits, dots, underscores and hyphens' })
  localPart: string;

  @ApiProperty({ description: 'Domain (id) — must already exist' })
  @IsString()
  domainId: string;

  @ApiProperty({ description: 'Project owning this mailbox' })
  @IsString()
  projectId: string;

  @ApiProperty()
  @IsString()
  password: string;

  @ApiProperty({ required: false, example: 2048 })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(102400)
  quotaMb?: number;

  @ApiProperty({ required: false, description: 'Forward all mail to this address (no local storage)' })
  @IsOptional()
  @IsEmail()
  forwardTo?: string;

  @ApiProperty({ required: false, description: 'Catch-all for the domain' })
  @IsOptional()
  @IsBoolean()
  catchAll?: boolean;
}
