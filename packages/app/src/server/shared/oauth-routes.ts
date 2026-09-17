/**
 * Shared OAuth 2.0 Routes
 *
 * OAuth endpoints used by both local and Lambda HTTP servers
 */

import { Express, Response } from 'express';
import cookieParser from 'cookie-parser';
import * as auth from '@/services/auth';
import * as pages from '@/ui/oauth-pages';
import { logger } from '@/utils/logger';
import { SUPPORTED_SCOPES, narrowAccess } from '@/services/access';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

const SESSION_EXPIRY_MS = Number(process.env.SESSION_EXPIRY_MS || 24 * 60 * 60 * 1000);

/**
 * Register all OAuth 2.0 endpoints on an Express app
 */
export function registerOAuthRoutes(app: Express, config: OAuthConfig): void {
  const { clientId, clientSecret, baseUrl } = config;

  app.use(cookieParser());

  const secureCookies = baseUrl.startsWith('https://');
  const sessionCookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax' as const,
    maxAge: SESSION_EXPIRY_MS,
    path: '/',
  };

  const setSessionCookie = (res: Response, sessionId: string) => {
    res.cookie('session_id', sessionId, sessionCookieOptions);
  };

  // The browser flow is split across two clients in some MCP hosts (the
  // ChatGPT desktop app fetches /oauth/authorize with its own HTTP client and
  // then opens the login page in a webview that has no cookie). So the
  // session is also carried explicitly as `s` in the URL and as a hidden form
  // field; the cookie is a convenience, not the only thread.
  const sessionRef = (req: any): string | undefined => {
    const raw = req.query?.s ?? req.body?.s;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  };
  const resolveSession = async (req: any): Promise<string | undefined> => {
    const ref = sessionRef(req);
    if (ref && (await auth.getSession(ref))) return ref;
    const cookie = req.cookies?.session_id;
    if (cookie && (await auth.getSession(cookie))) return cookie;
    return undefined;
  };
  const withRef = (path: string, sessionId?: string) =>
    sessionId ? `${path}?s=${encodeURIComponent(sessionId)}` : path;

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: SUPPORTED_SCOPES,
    });
  });

  // RFC 9728 protected-resource metadata. MCP clients (2025-06-18 auth spec)
  // probe this first to find the authorization server; without it some fall
  // back to guessing, others refuse to connect.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: SUPPORTED_SCOPES,
    });
  });

  app.get('/login', async (req, res) => {
    let sessionId = await resolveSession(req);
    if (!sessionId) {
      sessionId = await auth.createSession();
    }
    setSessionCookie(res, sessionId);
    res.send(pages.loginPage(undefined, sessionId));
  });

  app.post('/login', async (req, res) => {
    const { token } = req.body;
    let sessionId = await resolveSession(req);
    if (!sessionId) {
      sessionId = await auth.createSession();
    }
    setSessionCookie(res, sessionId);

    if (!token) {
      res.send(pages.loginPage('Please enter your authentication token', sessionId));
      return;
    }

    if (await auth.authenticateSession(sessionId, token)) {
      logger.info('Login succeeded', { sid: sessionId.slice(0, 8) });
      res.redirect(withRef('/oauth/consent', sessionId));
    } else {
      logger.warn('Login failed: wrong personal auth token', { sid: sessionId.slice(0, 8) });
      res.send(pages.loginPage('Invalid authentication token', sessionId));
    }
  });

  app.get('/oauth/authorize', async (req, res) => {
    const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } =
      req.query;
    const requestedScope = typeof req.query.scope === 'string' ? req.query.scope : undefined;

    if (
      !response_type ||
      !client_id ||
      !redirect_uri ||
      !code_challenge ||
      !code_challenge_method
    ) {
      return res
        .status(400)
        .send(pages.errorPage('invalid_request', 'Missing required parameters'));
    }

    if (response_type !== 'code') {
      return res
        .status(400)
        .send(
          pages.errorPage('unsupported_response_type', 'Only "code" response type is supported'),
        );
    }

    if (client_id !== clientId) {
      return res.status(400).send(pages.errorPage('invalid_client', 'Unknown client ID'));
    }

    if (code_challenge_method !== 'S256' && code_challenge_method !== 'plain') {
      return res
        .status(400)
        .send(pages.errorPage('invalid_request', 'code_challenge_method must be S256 or plain'));
    }

    let sessionId = await resolveSession(req);
    if (!sessionId) {
      sessionId = await auth.createSession();
    }
    setSessionCookie(res, sessionId);
    logger.info('Authorization request stored', { sid: sessionId.slice(0, 8), client_id });

    const stored = await auth.storePendingAuthRequest(
      sessionId,
      client_id as string,
      redirect_uri as string,
      code_challenge as string,
      code_challenge_method as 'S256' | 'plain',
      state as string | undefined,
      requestedScope,
    );

    if (!stored) {
      return res
        .status(400)
        .send(pages.errorPage('invalid_request', 'Unable to store authorization request'));
    }

    if (!(await auth.isAuthenticated(sessionId))) {
      return res.redirect(withRef('/login', sessionId));
    }

    return res.redirect(withRef('/oauth/consent', sessionId));
  });

  app.get('/oauth/consent', async (req, res) => {
    const sessionId = await resolveSession(req);

    if (!sessionId || !(await auth.isAuthenticated(sessionId))) {
      return res.redirect(withRef('/login', sessionId));
    }
    setSessionCookie(res, sessionId);

    const session = await auth.getSession(sessionId);
    if (!session?.pendingAuthRequest) {
      return res
        .status(400)
        .send(pages.errorPage('invalid_request', 'No pending authorization request'));
    }

    res.send(
      pages.consentPage(
        session.pendingAuthRequest.clientId,
        sessionId,
        narrowAccess(session.access ?? 'read', session.pendingAuthRequest.scope),
      ),
    );
  });

  app.post('/oauth/approve', async (req, res) => {
    const sessionId = await resolveSession(req);

    if (!sessionId || !(await auth.isAuthenticated(sessionId))) {
      return res.redirect(withRef('/login', sessionId));
    }

    // Read before consuming: the login decided what may be granted, and the
    // client's requested scope can only narrow it.
    const session = await auth.getSession(sessionId);
    const pending = await auth.consumePendingAuthRequest(sessionId);

    if (!pending) {
      return res
        .status(400)
        .send(pages.errorPage('invalid_request', 'No pending authorization request'));
    }

    const access = narrowAccess(session?.access ?? 'read', pending.scope);
    logger.info('Authorization approved', { sid: sessionId.slice(0, 8), access });

    const code = await auth.createAuthorizationCode(
      pending.codeChallenge,
      pending.codeChallengeMethod,
      pending.redirectUri,
      access,
    );

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (pending.state) {
      redirectUrl.searchParams.set('state', pending.state);
    }

    res.redirect(redirectUrl.toString());
  });

  app.get('/oauth/deny', async (req, res) => {
    const sessionId = await resolveSession(req);

    if (sessionId) {
      const pending = await auth.consumePendingAuthRequest(sessionId);

      if (pending) {
        const redirectUrl = new URL(pending.redirectUri);
        redirectUrl.searchParams.set('error', 'access_denied');
        redirectUrl.searchParams.set('error_description', 'User denied authorization');
        if (pending.state) {
          redirectUrl.searchParams.set('state', pending.state);
        }

        return res.redirect(redirectUrl.toString());
      }
    }

    res.send(pages.errorPage('access_denied', 'Authorization was denied'));
  });

  app.post('/oauth/token', async (req, res) => {
    const { grant_type, code, code_verifier, redirect_uri, refresh_token } = req.body;

    // RFC 6749 §2.3.1: servers MUST support HTTP Basic for client credentials;
    // the body form is optional. Most OAuth clients (ChatGPT included) send
    // Basic even when registration advertised client_secret_post. Header wins
    // when both are present.
    let { client_id, client_secret } = req.body;
    const authz = req.headers.authorization;
    if (authz?.startsWith('Basic ')) {
      const decoded = Buffer.from(authz.substring(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > 0) {
        client_id = decodeURIComponent(decoded.substring(0, sep));
        client_secret = decodeURIComponent(decoded.substring(sep + 1));
      }
    }

    // A confidential client (one that presented a secret) must present a
    // valid one. A public client presents none: ChatGPT's connector refreshes
    // that way, and PKCE (code_verifier on the code exchange) plus possession
    // of the refresh token are the real proof, not a shared secret. Requiring
    // the secret here was breaking refresh → the client thrashed on an expired
    // access token and the conversation lost its tools after an hour.
    if (client_secret) {
      if (!auth.validateClientCredentials(client_id, client_secret)) {
        logger.warn('Token request rejected: invalid client credentials', {
          grant_type,
          client_id,
          auth_method: authz?.startsWith('Basic ') ? 'client_secret_basic' : 'client_secret_post',
        });
        return res.status(401).json({
          error: 'invalid_client',
          error_description: 'Invalid client credentials',
        });
      }
    } else {
      logger.info('Token request from public client (no secret presented)', {
        grant_type,
        client_id,
      });
    }

    if (grant_type === 'authorization_code') {
      if (!code || !code_verifier || !redirect_uri) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required parameters',
        });
      }

      const result = await auth.exchangeCodeForToken(code, code_verifier, redirect_uri, client_id);

      if (!result) {
        logger.warn('Token request rejected: invalid grant', { grant_type });
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code',
        });
      }

      return res.json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
        scope: result.scope,
      });
    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing refresh_token parameter',
        });
      }

      const result = await auth.refreshAccessToken(refresh_token);

      if (!result) {
        logger.warn('Token request rejected: invalid grant', { grant_type });
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid or expired refresh token',
        });
      }

      return res.json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
        scope: result.scope,
      });
    }

    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code and refresh_token grant types are supported',
    });
  });

  app.post('/oauth/register', (req, res) => {
    const body = req.body ?? {};
    const redirectUris = body.redirect_uris;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris must be provided as a non-empty array of strings',
      });
    }

    if (redirectUris.some(uri => typeof uri !== 'string')) {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'Each redirect URI must be a string',
      });
    }

    if (!clientSecret) {
      return res.status(500).json({
        error: 'server_error',
        error_description: 'OAuth client secret is not configured on the server',
      });
    }

    const issuedAt = Math.floor(Date.now() / 1000);

    return res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: redirectUris,
      client_name: body.client_name ?? 'obsidian-mcp',
      client_id_issued_at: issuedAt,
    });
  });

  app.post('/oauth/revoke', async (req, res) => {
    const { token, client_id, client_secret } = req.body;

    if (!auth.validateClientCredentials(client_id, client_secret)) {
      return res.status(401).json({
        error: 'invalid_client',
        error_description: 'Invalid client credentials',
      });
    }

    if (!token) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing token parameter',
      });
    }

    await auth.revokeToken(token);

    return res.status(200).json({});
  });
}
