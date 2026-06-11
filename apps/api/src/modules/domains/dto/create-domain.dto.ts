import { IsString, IsOptional, IsBoolean, IsInt, Matches, MaxLength, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// RFC 1035 hostname: labels of 1-63 chars [a-z0-9-] separated by '.', no leading/trailing '-'.
// Total length capped at 253. The regex rejects whitespace, quotes, braces — anything that
// would let an attacker inject syntax into the generated Caddyfile.
const DOMAIN_RE = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;

export class CreateDomainDto {
  @ApiProperty({ example: 'app.example.com' })
  @IsString()
  @MaxLength(253)
  @Matches(DOMAIN_RE, {
    message: 'domain must be a valid RFC 1035 hostname (a-z, 0-9, -, labels ≤ 63 chars).',
  })
  domain!: string;

  @ApiProperty({ description: 'Project owning this domain (required — mail-only domains too)' })
  @IsString()
  projectId!: string;

  @ApiProperty({ required: false, description: 'Optional — link to a web app for HTTP routing' })
  @IsOptional()
  @IsString()
  applicationId?: string;

  @ApiProperty({
    required: false,
    description:
      'Optional — bind the app on http://<domain>:<port> (DomainPortBinding) instead of the '
      + 'clean-URL :443 slot. Requires applicationId. The port must match a host port the app '
      + 'container actually publishes — Caddy only listens on 80/443, port-pinned URLs hit the '
      + 'container publish directly.',
  })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(65535)
  port?: number;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  autoSsl?: boolean;
}
