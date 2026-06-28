import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FixPermissionsDto {
  @ApiProperty({
    required: false,
    example: 'app',
    description: 'Directory to fix recursively (defaults to the whole app root). dirs→775, files→664.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  @Matches(/^(?!.*\.\.).*$/, { message: 'path must not contain ".." segments' })
  path?: string;

  @ApiProperty({
    required: false,
    example: 'www-data:www-data',
    description: 'Optional owner to set (container/remote modes). Strict charset.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(65)
  @Matches(/^([a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?|\d{1,7}(:\d{1,7})?)$/, {
    message: 'owner must be user, user:group, or numeric uid[:gid]',
  })
  owner?: string;
}
