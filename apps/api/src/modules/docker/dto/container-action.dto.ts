import { IsString, IsIn, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ContainerActionDto {
  @ApiProperty({
    description: 'Container ID (12 or 64 hex chars) or container name.',
  })
  @IsString()
  @Matches(/^([a-f0-9]{12}|[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/, {
    message: 'containerId must be a docker id (12/64 hex) or a valid name.',
  })
  containerId!: string;

  @ApiProperty({ enum: ['start', 'stop', 'restart', 'remove', 'kill'] })
  @IsIn(['start', 'stop', 'restart', 'remove', 'kill'])
  action!: string;
}
