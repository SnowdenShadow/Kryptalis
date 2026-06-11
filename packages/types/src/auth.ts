import { UserRole } from './enums';

export interface LoginRequest {
  email: string;
  password: string;
  totpCode?: string;
  /** Single-use backup code (used if TOTP device is lost). */
  backupCode?: string;
}

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

/**
 * Per-user notification preferences (User.notificationPrefs Json column).
 * Shape: { [event]: { [channel]: boolean } } — opt-out model (absent =
 * allowed). Events/channels outside the API whitelist are silently dropped
 * on write (see apps/api/src/modules/users/users.service.ts).
 */
export type NotificationPrefs = Record<string, Record<string, boolean>>;

export interface NotificationPrefsResponse {
  prefs: NotificationPrefs;
}

export interface UserResponse {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  twoFactorEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
