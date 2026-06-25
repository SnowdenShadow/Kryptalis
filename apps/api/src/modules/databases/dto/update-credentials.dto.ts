import { IsString, IsOptional, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Reset a database user's password. Password is OPTIONAL — when omitted the
 * service generates a strong one (CSPRNG) and returns it once. When provided it
 * uses the SAME charset constraint as create (no quotes/spaces/newlines) so it
 * can never break the SQL we send via stdin to the engine.
 */
export class ResetPasswordDto {
  @ApiProperty({ required: false, description: 'Leave empty to auto-generate a strong password.' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_@#%^*+=.!-]+$/, {
    message: 'password may only contain letters, digits and _@#%^*+=.!- (no quotes, spaces or newlines)',
  })
  password?: string;
}

/**
 * Rename a database user. The value is interpolated as a SQL identifier, so it
 * is restricted to a strict identifier shape (no injection surface).
 */
export class ChangeUsernameDto {
  @ApiProperty({ example: 'app_user' })
  @IsString()
  @MaxLength(63)
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
    message: 'username must start with a letter or underscore and contain only letters, digits and underscores',
  })
  username: string;
}
