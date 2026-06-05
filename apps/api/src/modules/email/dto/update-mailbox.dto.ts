import { IsOptional, IsInt, Min, Max, IsBoolean, IsEmail, IsString, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MailboxStatus } from '@prisma/client';

export class UpdateMailboxDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(102400)
  quotaMb?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  forwardTo?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  catchAll?: boolean;

  @ApiProperty({ required: false, enum: MailboxStatus })
  @IsOptional()
  @IsEnum(MailboxStatus)
  status?: MailboxStatus;
}
