import { IsString, IsNotEmpty, MaxLength, IsOptional, IsBoolean, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExtractZipDto {
  @ApiProperty({ example: 'app/prestashop.tar.gz', description: 'Relative path to the archive (.zip, .tar.gz, .tgz, .tar, .gz) to extract.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  // Reject obvious traversal at the DTO boundary too (the service re-validates).
  @Matches(/^(?!.*\.\.).+\.(zip|tar\.gz|tgz|tar|gz)$/i, {
    message: 'path must be a .zip/.tar.gz/.tgz/.tar/.gz file with no ".." segments',
  })
  path: string;

  @ApiProperty({ required: false, default: false, description: 'Delete the archive after a successful extraction.' })
  @IsOptional()
  @IsBoolean()
  deleteAfter?: boolean;
}
