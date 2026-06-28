import { IsString, IsNotEmpty, MaxLength, Matches, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChownDto {
  @ApiProperty({ example: 'var', description: 'Relative path to chown.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  @Matches(/^(?!.*\.\.).+$/, { message: 'path must not contain ".." segments' })
  path: string;

  @ApiProperty({
    example: 'www-data:www-data',
    description: 'Owner as "user", "user:group", or numeric "uid[:gid]". Strict charset (no shell metacharacters).',
  })
  @IsString()
  @MaxLength(65)
  // Mirror perms-util's accepted forms at the DTO boundary (service re-validates).
  @Matches(/^([a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?|\d{1,7}(:\d{1,7})?)$/, {
    message: 'owner must be user, user:group, or numeric uid[:gid]',
  })
  owner: string;

  @ApiProperty({ required: false, default: false, description: 'Apply recursively (directories).' })
  @IsOptional()
  @IsBoolean()
  recursive?: boolean;
}
