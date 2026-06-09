import { IsString, IsInt, Min, Max, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class OpenTerminalDto {
  @ApiProperty({ description: 'Application id whose container to attach to' })
  @IsString()
  @IsNotEmpty()
  appId: string;
}

export class WriteTerminalDto {
  @ApiProperty({ description: 'Raw keystrokes — bytes appended to the shell stdin' })
  @IsString()
  data: string;
}

export class ResizeTerminalDto {
  @ApiProperty({ minimum: 1, maximum: 1000 })
  @IsInt()
  @Min(1)
  @Max(1000)
  cols: number;

  @ApiProperty({ minimum: 1, maximum: 1000 })
  @IsInt()
  @Min(1)
  @Max(1000)
  rows: number;
}
