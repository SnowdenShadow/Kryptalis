import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for PUT /users/me/notification-preferences.
 * `prefs` is a free-form event → channel → bool map; the service sanitizes
 * it against the known event/channel whitelists so arbitrary junk never
 * lands in the Json column.
 */
export class UpdateNotificationPrefsDto {
  @ApiProperty({
    description: 'Event → channel → enabled map',
    example: { deployFail: { email: true, slack: false } },
  })
  @IsObject()
  prefs: Record<string, Record<string, boolean>>;
}
