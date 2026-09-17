import crypto from 'crypto';
import { getAuthStore } from './auth-store-singleton.js';
import type { SessionData } from './stores/types.js';
import { logger } from '@/utils/logger';
import type { AccessLevel } from '@/services/access';

const SESSION_EXPIRY_MS = Number(process.env.SESSION_EXPIRY_MS || 24 * 60 * 60 * 1000);

export type Session = SessionData;

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createSession(): Promise<string> {
  try {
    const sessionId = generateSessionId();
    const now = Date.now();

    const session: Session = {
      sessionId,
      authenticated: false,
      createdAt: now,
      expiresAt: now + SESSION_EXPIRY_MS,
    };

    const store = getAuthStore();
    await store.setSession(session);

    logger.debug('Session created', {
      sessionId,
      expiresAt: session.expiresAt,
    });

    return sessionId;
  } catch (error) {
    logger.error('Error creating session', { error });
    throw error;
  }
}

export async function getSession(sessionId: string): Promise<Session | null> {
  try {
    if (!sessionId) {
      return null;
    }

    const store = getAuthStore();
    const session = await store.getSession(sessionId);

    if (!session) {
      return null;
    }

    if (Date.now() > session.expiresAt) {
      await store.deleteSession(sessionId);
      return null;
    }

    return session;
  } catch (error) {
    logger.error('Error getting session', { error });
    return null;
  }
}

function matchesSecret(configured: string | undefined, provided: string): boolean {
  if (!configured) return false;
  const expected = Buffer.from(configured);
  const given = Buffer.from(provided);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * The access a login token grants, or null if it matches neither.
 *
 * PERSONAL_AUTH_TOKEN grants read and write; the optional
 * PERSONAL_AUTH_TOKEN_RO grants read only. Both comparisons always run, so
 * the response time does not reveal which one a guess was closer to. If the
 * two are configured with the same value the result is read: an ambiguous
 * credential fails closed, and the overlap is reported at startup.
 */
export function accessForLoginToken(providedToken: unknown): AccessLevel | null {
  if (typeof providedToken !== 'string' || providedToken.length === 0) return null;
  const isWrite = matchesSecret(process.env.PERSONAL_AUTH_TOKEN, providedToken);
  const isRead = matchesSecret(process.env.PERSONAL_AUTH_TOKEN_RO, providedToken);
  if (isRead) return 'read';
  return isWrite ? 'write' : null;
}

/**
 * Authenticate a login session. Resolves to the access level granted, or null
 * when the token is wrong.
 */
export async function authenticateSession(
  sessionId: string,
  providedToken: string,
): Promise<AccessLevel | null> {
  const session = await getSession(sessionId);

  if (!session) {
    return null;
  }

  if (!process.env.PERSONAL_AUTH_TOKEN && !process.env.PERSONAL_AUTH_TOKEN_RO) {
    logger.error('PERSONAL_AUTH_TOKEN not configured');
    return null;
  }

  const access = accessForLoginToken(providedToken);

  if (access) {
    const updatedSession: Session = {
      ...session,
      authenticated: true,
      access,
    };
    const store = getAuthStore();
    await store.setSession(updatedSession);

    logger.info('Session authenticated successfully', {
      sessionId,
      access,
    });
  } else {
    logger.warn('Session authentication failed', {
      sessionId,
    });
  }

  return access;
}

export async function storePendingAuthRequest(
  sessionId: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: 'S256' | 'plain',
  state?: string,
  scope?: string,
): Promise<boolean> {
  try {
    const session = await getSession(sessionId);

    if (!session) {
      logger.debug('Session not found', { sessionId });
      return false;
    }

    const updatedSession: Session = {
      ...session,
      pendingAuthRequest: {
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
      },
    };

    const store = getAuthStore();
    await store.setSession(updatedSession);

    return true;
  } catch (error) {
    logger.error('Error storing pending auth request', { error });
    return false;
  }
}

export async function consumePendingAuthRequest(
  sessionId: string,
): Promise<Session['pendingAuthRequest'] | null> {
  const session = await getSession(sessionId);

  if (!session || !session.authenticated || !session.pendingAuthRequest) {
    return null;
  }

  const request = session.pendingAuthRequest;

  const updatedSession: Session = {
    ...session,
    pendingAuthRequest: undefined,
  };

  const store = getAuthStore();
  await store.setSession(updatedSession);

  return request;
}

export async function isAuthenticated(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  return session?.authenticated || false;
}

export async function destroySession(sessionId: string): Promise<void> {
  const store = getAuthStore();
  await store.deleteSession(sessionId);
}
