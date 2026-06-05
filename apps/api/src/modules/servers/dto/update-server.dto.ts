import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateServerDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;
}
