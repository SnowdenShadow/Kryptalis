import { IsEmail, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for the email-only endpoints (forgot-password / resend-verification).
 * Validates the shape at the HTTP boundary like every other DTO; the service
 * still returns a generic success regardless, so this leaks nothing about
 * whether the address exists.
 */
export class EmailOnlyDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;
}
