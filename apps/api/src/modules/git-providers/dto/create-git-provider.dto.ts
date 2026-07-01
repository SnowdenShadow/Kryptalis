import { IsString, IsIn, ValidateIf, IsUrl } from 'class-validator';
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
  //
  // ValidateIf (not IsOptional): the dashboard form always sends baseUrl, as ''
  // for the SaaS providers. IsOptional only skips null/undefined, so '' would
  // still hit @IsUrl and 400 EVERY GitHub/GitLab/Bitbucket connection. Skip the
  // URL check when it's absent OR empty; the service still requires a real URL
  // for GITEA/FORGEJO.
  @ApiProperty({ required: false, description: 'Instance base URL for self-hosted Gitea/Forgejo' })
  @ValidateIf((o) => o.baseUrl != null && o.baseUrl !== '')
  @IsUrl({ require_tld: false, protocols: ['https'] })
  baseUrl?: string;
}
