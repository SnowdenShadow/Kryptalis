import { IsString, IsOptional, IsIn, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDatabaseDto {
  // The name is interpolated into a generated docker-compose.yml (service
  // key, container_name, POSTGRES_DB, …). Restrict it to a safe slug so a
  // crafted value can never inject YAML keys or break the container name.
  @ApiProperty({ example: 'mydb' })
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z][a-z0-9-]*$/, {
    message: 'name must start with a letter and contain only lowercase letters, digits and dashes',
  })
  name: string;

  @ApiProperty({ enum: ['POSTGRESQL', 'MYSQL', 'MARIADB', 'REDIS', 'KEYDB', 'DRAGONFLY', 'MONGODB', 'CLICKHOUSE'] })
  @IsIn(['POSTGRESQL', 'MYSQL', 'MARIADB', 'REDIS', 'KEYDB', 'DRAGONFLY', 'MONGODB', 'CLICKHOUSE'])
  type: string;

  @ApiProperty()
  @IsString()
  serverId: string;

  // Same constraint: lands in the compose env block (MYSQL_USER, …).
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
    message: 'username must start with a letter and contain only letters, digits and underscores',
  })
  username?: string;

  // Interpolated into the compose env block — forbid YAML-breaking chars.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_@#%^*+=.!-]+$/, {
    message: 'password may only contain letters, digits and _@#%^*+=.!- (no quotes, spaces or newlines)',
  })
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
