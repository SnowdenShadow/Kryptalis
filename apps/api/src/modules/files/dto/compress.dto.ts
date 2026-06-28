import {
  IsArray,
  IsString,
  ArrayMinSize,
  ArrayMaxSize,
  MaxLength,
  Matches,
  IsOptional,
  IsIn,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CompressDto {
  @ApiProperty({
    type: [String],
    example: ['app/index.php', 'app/config'],
    description: 'Relative paths (files or directories) to include in the archive.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(4096, { each: true })
  // Reject obvious traversal at the DTO boundary (the service re-validates).
  @Matches(/^(?!.*\.\.).+$/, { each: true, message: 'paths must not contain ".." segments' })
  paths: string[];

  @ApiProperty({
    required: false,
    enum: ['zip', 'tar.gz'],
    default: 'zip',
    description: 'Archive format to produce.',
  })
  @IsOptional()
  @IsIn(['zip', 'tar.gz'])
  format?: 'zip' | 'tar.gz';
}
