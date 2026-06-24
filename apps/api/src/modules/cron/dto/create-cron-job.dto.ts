import { IsString, IsBoolean, IsOptional, IsNotEmpty, MaxLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { isValidCron, CRON_SCHEDULE_MESSAGE } from '../cron-schedule.util';

/** class-validator hook around the pure cron parser. */
@ValidatorConstraint({ name: 'isCron', async: false })
export class IsCronConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCron(value);
  }
  defaultMessage(): string {
    return CRON_SCHEDULE_MESSAGE;
  }
}

export class CreateCronJobDto {
  @ApiProperty({ example: 'Clear cache' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({ example: 'clx...', description: 'Application the command runs inside.' })
  @IsString()
  @IsNotEmpty()
  applicationId: string;

  @ApiProperty({ example: '*/5 * * * *', description: 'Standard 5-field cron expression.' })
  @IsString()
  @Validate(IsCronConstraint)
  schedule: string;

  @ApiProperty({ example: 'php artisan cache:clear', description: 'Shell command run as `sh -c` inside the container.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  command: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
