import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RefreshTokenDto {
  /**
   * Optional since the refresh token moved to the httpOnly
   * `dockcontrol_rt` cookie — modern clients POST an empty body and the
   * cookie wins. Legacy clients still send it here (fallback path).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
