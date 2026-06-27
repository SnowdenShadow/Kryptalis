import { IsString, IsNotEmpty, MaxLength, IsOptional, IsBoolean, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExtractZipDto {
  @ApiProperty({ example: 'app/prestashop.zip', description: 'Relative path to the .zip archive to extract.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  // Reject obvious traversal at the DTO boundary too (the service re-validates).
  @Matches(/^(?!.*\.\.).+\.zip$/i, {
    message: 'path must be a .zip file with no ".." segments',
  })
  path: string;

  @ApiProperty({ required: false, default: false, description: 'Delete the .zip after a successful extraction.' })
  @IsOptional()
  @IsBoolean()
  deleteAfter?: boolean;
}
