import type { AccessLevel } from '@/services/access';

export interface SessionData {
  sessionId: string;
  authenticated: boolean;
  /** What the credential used at login allows. Unset until authenticated. */
  access?: AccessLevel;
  createdAt: number;
  expiresAt: number;
  pendingAuthRequest?: {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256' | 'plain';
    /** The `scope` the client asked for, if any. It can narrow, never widen. */
    scope?: string;
  };
}

export interface AuthCodeData {
  code: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  /** Absent on codes issued before access levels existed; treated as read. */
  access?: AccessLevel;
}

export interface AccessTokenData {
  token: string;
  refreshToken: string;
  createdAt: number;
  expiresAt: number;
  scope: string;
}

export interface RefreshTokenData {
  refreshToken: string;
  accessToken: string;
}

export interface SessionRepository {
  getSession(sessionId: string): Promise<SessionData | null>;
  setSession(session: SessionData): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface OAuthTokenRepository {
  getAuthCode(code: string): Promise<AuthCodeData | null>;
  setAuthCode(data: AuthCodeData): Promise<void>;
  deleteAuthCode(code: string): Promise<void>;

  getAccessToken(token: string): Promise<AccessTokenData | null>;
  setAccessToken(data: AccessTokenData): Promise<void>;
  deleteAccessToken(token: string): Promise<void>;

  getRefreshToken(refreshToken: string): Promise<RefreshTokenData | null>;
  setRefreshToken(data: RefreshTokenData): Promise<void>;
  deleteRefreshToken(refreshToken: string): Promise<void>;
}

export interface AuthStore extends SessionRepository, OAuthTokenRepository {}
