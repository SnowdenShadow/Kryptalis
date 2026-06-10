import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExecCommandDto {
  @ApiProperty({ example: 'ls -la' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  command: string;
}
