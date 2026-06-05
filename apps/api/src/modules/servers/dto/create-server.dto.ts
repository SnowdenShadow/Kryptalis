import { IsString, IsInt, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateServerDto {
  @ApiProperty({ example: 'Production VPS' })
  @IsString()
  name: string;

  @ApiProperty({ example: '192.168.1.100' })
  @IsString()
  host: string;

  @ApiProperty({ example: 22 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiProperty({ example: 'root' })
  @IsString()
  username: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  privateKey?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  password?: string;
}
