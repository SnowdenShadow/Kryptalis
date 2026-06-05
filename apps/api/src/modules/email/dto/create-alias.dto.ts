import { IsString, IsOptional, IsEmail, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAliasDto {
  @ApiProperty({ example: 'sales', description: 'Local part of the alias address' })
  @IsString()
  @Matches(/^[a-z0-9._-]+$/i)
  localPart: string;

  @ApiProperty()
  @IsString()
  domainId: string;

  @ApiProperty({ required: false, description: 'Internal target mailbox id (preferred when same domain)' })
  @IsOptional()
  @IsString()
  targetMailboxId?: string;

  @ApiProperty({ required: false, description: 'External forwarding address' })
  @IsOptional()
  @IsEmail()
  forwardTo?: string;
}
