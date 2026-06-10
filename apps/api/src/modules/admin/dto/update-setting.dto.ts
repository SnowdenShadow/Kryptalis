import { IsDefined } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSettingDto {
  @ApiProperty({ description: 'New value for the setting (any JSON value)' })
  @IsDefined()
  value: unknown;
}
