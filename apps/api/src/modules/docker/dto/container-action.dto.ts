import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ContainerActionDto {
  @ApiProperty()
  @IsString()
  containerId: string;

  @ApiProperty({ enum: ['start', 'stop', 'restart', 'remove'] })
  @IsIn(['start', 'stop', 'restart', 'remove'])
  action: string;
}
