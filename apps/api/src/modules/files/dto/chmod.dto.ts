import { IsString, IsNotEmpty, MaxLength, Matches, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChmodDto {
  @ApiProperty({ example: 'var/cache', description: 'Relative path to chmod.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  @Matches(/^(?!.*\.\.).+$/, { message: 'path must not contain ".." segments' })
  path: string;

  @ApiProperty({ example: '775', description: 'Octal mode (3–4 digits, 0–7). setuid/setgid/sticky not allowed.' })
  @IsString()
  @Matches(/^[0-7]{3,4}$/, { message: 'mode must be an octal string like "755"' })
  mode: string;

  @ApiProperty({ required: false, default: false, description: 'Apply recursively (directories).' })
  @IsOptional()
  @IsBoolean()
  recursive?: boolean;
}
