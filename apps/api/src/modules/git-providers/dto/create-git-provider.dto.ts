import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateGitProviderDto {
  @ApiProperty({ enum: ['GITHUB', 'GITLAB', 'BITBUCKET'] })
  @IsIn(['GITHUB', 'GITLAB', 'BITBUCKET'])
  provider: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  token: string;
}
