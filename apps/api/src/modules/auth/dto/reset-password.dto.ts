import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /auth/reset-password. The token is the one-time reset token;
 * newPassword strength is re-checked in the service against the shared policy
 * (password-policy.ts). totpCode/backupCode gate the 2FA-protected reset.
 */
export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(10)
  token: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  newPassword: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  totpCode?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  backupCode?: string;
}
