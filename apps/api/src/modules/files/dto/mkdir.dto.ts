import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MkdirDto {
  @ApiProperty({ example: 'logs/archive' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  path: string;
}
