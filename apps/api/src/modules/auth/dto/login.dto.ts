import { IsEmail, IsString, IsOptional, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'securepassword123' })
  @IsString()
  @MinLength(1)
  password!: string;

  @ApiProperty({ required: false, description: 'TOTP code from your authenticator app (6 digits).' })
  @IsOptional()
  @IsString()
  totpCode?: string;

  @ApiProperty({ required: false, description: 'Single-use backup code (used if TOTP device is lost).' })
  @IsOptional()
  @IsString()
  backupCode?: string;
}
