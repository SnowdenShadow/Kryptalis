import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDatabaseDto {
  @ApiProperty({ example: 'mydb' })
  @IsString()
  name: string;

  @ApiProperty({ enum: ['POSTGRESQL', 'MYSQL', 'MARIADB', 'REDIS', 'KEYDB', 'DRAGONFLY', 'MONGODB', 'CLICKHOUSE'] })
  @IsIn(['POSTGRESQL', 'MYSQL', 'MARIADB', 'REDIS', 'KEYDB', 'DRAGONFLY', 'MONGODB', 'CLICKHOUSE'])
  type: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiProperty({ required: false, description: 'Attach the database to a project (recommended)' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiProperty({ required: false, description: 'Attach the database to a specific application' })
  @IsOptional()
  @IsString()
  applicationId?: string;
}
