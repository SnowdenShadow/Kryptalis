import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class IssueSslDto {
  @ApiProperty()
  @IsString()
  domainId: string;
}
