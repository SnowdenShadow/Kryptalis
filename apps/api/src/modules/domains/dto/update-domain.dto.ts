import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for PATCH /domains/:id. Deliberately a class (not a plain interface) so
 * the global ValidationPipe({ whitelist: true }) strips any unknown property —
 * notably `projectId`, which must NOT be settable here: re-homing a domain to a
 * different project (or orphaning it via projectId:null) is privileged and only
 * allowed through the ADMIN-gated POST /domains/:id/transfer endpoint.
 *
 * The only field a DEVELOPER may change here is the linked application:
 *   - applicationId: string  → attach the domain to that app
 *   - applicationId: null    → detach the domain from its current app
 */
export class UpdateDomainDto {
  @ApiPropertyOptional({
    description: 'Application to attach the domain to, or null to detach',
    nullable: true,
  })
  @IsOptional()
  // Allow explicit null (detach) while still type-checking non-null values.
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  applicationId?: string | null;
}
