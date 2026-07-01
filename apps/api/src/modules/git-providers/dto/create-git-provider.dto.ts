import { IsString, IsIn, IsOptional, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateGitProviderDto {
  @ApiProperty({ enum: ['GITHUB', 'GITLAB', 'BITBUCKET', 'GITEA', 'FORGEJO'] })
  @IsIn(['GITHUB', 'GITLAB', 'BITBUCKET', 'GITEA', 'FORGEJO'])
  provider: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  token: string;

  // Self-hosted instance URL — required for GITEA/FORGEJO (validated in the
  // service, which screens the host for SSRF before the token is used). Ignored
  // for the SaaS providers. require_tld:false so a LAN host like
  // https://git.internal is accepted when ALLOW_PRIVATE_GIT_HOSTS is on.
  @ApiProperty({ required: false, description: 'Instance base URL for self-hosted Gitea/Forgejo' })
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['https'] })
  baseUrl?: string;
}
