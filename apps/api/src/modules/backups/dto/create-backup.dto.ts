import { IsString, IsOptional, IsBoolean, IsIn, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  BACKUP_SCHEDULE_PATTERN,
  BACKUP_SCHEDULE_MESSAGE,
} from '../backup-schedule.util';

export class CreateBackupDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty({
    required: false,
    description:
      'Scope the backup to a single project (its apps + databases + volumes). ' +
      'Omit for a whole-server backup (every project on the server).',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiProperty({ enum: ['LOCAL', 'S3', 'R2', 'B2'] })
  @IsIn(['LOCAL', 'S3', 'R2', 'B2'])
  target: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  includeApplications?: boolean;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  includeDatabases?: boolean;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  includeVolumes?: boolean;

  @ApiProperty({
    required: false,
    description:
      'Recurring schedule: @hourly, @daily, @weekly, or "<minute> <hour> * * *".',
  })
  @IsOptional()
  @IsString()
  @Matches(BACKUP_SCHEDULE_PATTERN, { message: BACKUP_SCHEDULE_MESSAGE })
  schedule?: string;
}
