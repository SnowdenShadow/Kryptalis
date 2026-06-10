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

export interface UserResponse {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  twoFactorEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
