import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for POST /email/server/:domainId/deploy.
 *
 * `serverId` chooses which registered server the mail stack runs on. Omitted
 * (or null) keeps the historical behaviour: the platform primary host. On a
 * RE-deploy the value is ignored if a server was already chosen at first
 * deploy — a mail server doesn't move hosts implicitly (that's a separate,
 * out-of-scope operation).
 */
export class DeployMailServerDto {
  @ApiPropertyOptional({
    description: 'Target server id to run the mail stack on (default: primary host)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  serverId?: string;
}
