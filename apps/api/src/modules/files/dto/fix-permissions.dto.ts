import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FixPermissionsDto {
  @ApiProperty({ enum: ['prestashop'], description: 'Permission preset to apply.' })
  @IsIn(['prestashop'])
  preset: 'prestashop';
}
