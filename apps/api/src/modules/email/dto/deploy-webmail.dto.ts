import { IsOptional, IsIn, IsString, IsInt, Min, Max, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * How to expose the 1-click Roundcube webmail:
 *  - newDomain      → create + attach a dedicated subdomain (e.g. webmail.<apex>)
 *  - existingDomain → attach to a domain the user already owns (targetDomainId)
 *  - port           → direct IP:port access, no domain / TLS (hostPort)
 *
 * The IMAP/SMTP config is always injected server-side from the mail server, so
 * the user only picks WHERE to reach it.
 */
export class DeployWebmailDto {
  @ApiProperty({ enum: ['newDomain', 'existingDomain', 'port'], default: 'newDomain' })
  @IsIn(['newDomain', 'existingDomain', 'port'])
  access: string;

  @ApiProperty({ required: false, example: 'webmail.example.com' })
  @IsOptional()
  @IsString()
  @Matches(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, {
    message: 'newDomain must be a valid domain name',
  })
  newDomain?: string;

  @ApiProperty({ required: false, description: 'Existing domain id to serve the webmail on' })
  @IsOptional()
  @IsString()
  targetDomainId?: string;

  @ApiProperty({ required: false, description: 'Host port for direct IP:port access (1024-65535)' })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(65535)
  hostPort?: number;
}
