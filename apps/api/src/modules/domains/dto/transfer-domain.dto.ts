import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TransferDomainDto {
  @ApiProperty({ description: 'Project to move the domain to' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  targetProjectId: string;
}
