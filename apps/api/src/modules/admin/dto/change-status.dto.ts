import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';

export class ChangeStatusDto {
  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus)
  status: UserStatus;
}
