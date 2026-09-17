/**
 * Access levels, end to end over HTTP: real OAuth logins with each password,
 * real bearer tokens, real MCP sessions. The vault is in memory; everything
 * else is the code the server runs.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOAuthRoutes } from '@/server/shared/oauth-routes';
import { registerMcpRoute } from '@/server/shared/mcp-routes';
import { registerTools } from '@/mcp/tool-registrations';
import { registerOrientTool } from '@/mcp/orient-tool';
import { setAuthStore, createInMemoryAuthStore } from '@/services/auth';
import { readOnlyVaultManager, READ_ONLY_ERROR } from '@/services/read-only-vault';
import { READ_ONLY_TOOLS } from '@/mcp/tool-allowlist';
import type { AccessLevel } from '@/services/access';
import { BRAIN_PROTOCOL_PATH } from '@/mcp/brain-protocol';
import { configureLogger } from '@/utils/logger';
import { InMemoryVaultManager } from '../support/doubles/in-memory-vault-manager.js';

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-client-secret';
const LOGIN_RW = 'login-token-read-write';
const LOGIN_RO = 'login-token-read-only';
const STATIC_RW = 'static-bearer-read-write';
const STATIC_RO = 'static-bearer-read-only';
const REDIRECT_URI = 'https://client.example/callback';
const PKCE = 'plain-pkce-challenge-value';

const ENV_KEYS = [
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'PERSONAL_AUTH_TOKEN',
  'PERSONAL_AUTH_TOKEN_RO',
  'MCP_STATIC_BEARER_TOKENS',
  'MCP_STATIC_BEARER_TOKENS_RO',
  'EXPOSED_TOOLS',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let vault: InMemoryVaultManager;
let app: Express;
/**
 * The two layers of defence, switchable so each can be tested with the other
 * taken away.
 */
let readSessions: { guardVault: boolean; filterTools: boolean };

function buildApp(): Express {
  const created = express();
  created.use(express.json());
  created.use(express.urlencoded({ extended: true }));

  const createServer = (access: AccessLevel): McpServer => {
    const isRead = access === 'read';
    const sessionVault = isRead && readSessions.guardVault ? readOnlyVaultManager(vault) : vault;
    const server = new McpServer({ name: 'test', version: '0' });
    registerTools(
      server,
      () => sessionVault,
      isRead && !readSessions.filterTools ? 'write' : access,
    );
    registerOrientTool(server, () => sessionVault);
    return server;
  };

  registerOAuthRoutes(created, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    baseUrl: 'http://localhost',
  });
  registerMcpRoute(created, createServer('write'), { createServer });
  return created;
}

beforeAll(() => {
  configureLogger({
    stream: { write: () => true } as unknown as NodeJS.WriteStream,
    minLevel: 'error',
  });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  process.env.OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.OAUTH_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PERSONAL_AUTH_TOKEN = LOGIN_RW;
  process.env.PERSONAL_AUTH_TOKEN_RO = LOGIN_RO;
  process.env.MCP_STATIC_BEARER_TOKENS = STATIC_RW;
  process.env.MCP_STATIC_BEARER_TOKENS_RO = STATIC_RO;
  delete process.env.EXPOSED_TOOLS;

  setAuthStore(createInMemoryAuthStore());
  vault = new InMemoryVaultManager({
    'Home.md': '# Home',
    [BRAIN_PROTOCOL_PATH]: '# Brain protocol',
  });
  readSessions = { guardVault: true, filterTools: true };
  app = buildApp();
});

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  scope: string;
}

/** Runs the authorization-code flow and returns the consent HTML and tokens. */
async function logIn(
  loginToken: string,
  requestedScope?: string,
): Promise<{ consentHtml: string; tokens: TokenResponse }> {
  const authorize = await request(app)
    .get('/oauth/authorize')
    .query({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: PKCE,
      code_challenge_method: 'plain',
      state: 'state-1',
      ...(requestedScope ? { scope: requestedScope } : {}),
    });
  expect(authorize.status).toBe(302);
  const sessionRef = new URL(authorize.headers.location, 'http://localhost').searchParams.get('s')!;

  const login = await request(app)
    .post('/login')
    .type('form')
    .send({ token: loginToken, s: sessionRef });
  expect(login.status).toBe(302);

  const consent = await request(app).get('/oauth/consent').query({ s: sessionRef });
  expect(consent.status).toBe(200);

  const approve = await request(app).post('/oauth/approve').type('form').send({ s: sessionRef });
  expect(approve.status).toBe(302);
  const code = new URL(approve.headers.location).searchParams.get('code')!;

  const token = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: PKCE,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  expect(token.status).toBe(200);

  return { consentHtml: consent.text, tokens: token.body as TokenResponse };
}

const mcpPost = (bearer: string, body: object, sessionId?: string) => {
  const req = request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${bearer}`)
    .set('Accept', 'application/json, text/event-stream');
  if (sessionId) req.set('mcp-session-id', sessionId);
  return req.send(body);
};

/** Opens an MCP session and returns its id. */
async function openSession(bearer: string): Promise<string> {
  const init = await mcpPost(bearer, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0' },
    },
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers['mcp-session-id'];
  await mcpPost(bearer, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  return sessionId;
}

async function listTools(bearer: string, sessionId: string): Promise<string[]> {
  const res = await mcpPost(bearer, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
  return (res.body.result.tools as Array<{ name: string }>).map(t => t.name).sort();
}

const callTool = (bearer: string, sessionId: string, name: string, args: object) =>
  mcpPost(
    bearer,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
    sessionId,
  );

const READ_SESSION_TOOLS = [...READ_ONLY_TOOLS, 'orient'].sort();

describe('OAuth login decides the access level', () => {
  it('issues a read-and-write token for the read-write login token', async () => {
    const { tokens } = await logIn(LOGIN_RW);

    expect(tokens.scope).toBe('vault:read vault:write');
  });

  it('issues a read-only token for the read-only login token', async () => {
    const { tokens } = await logIn(LOGIN_RO);

    expect(tokens.scope).toBe('vault:read');
  });

  it('rejects a login token that matches neither', async () => {
    const authorize = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: PKCE,
      code_challenge_method: 'plain',
    });
    const sessionRef = new URL(authorize.headers.location, 'http://localhost').searchParams.get(
      's',
    )!;

    const login = await request(app)
      .post('/login')
      .type('form')
      .send({ token: 'wrong', s: sessionRef });
    const consent = await request(app).get('/oauth/consent').query({ s: sessionRef });

    expect(login.status).toBe(200);
    expect(login.text).toContain('Invalid authentication token');
    expect(consent.status).toBe(302);
  });

  it('narrows a read-write login to read when the client asks only to read', async () => {
    const { tokens } = await logIn(LOGIN_RW, 'vault:read');

    expect(tokens.scope).toBe('vault:read');
  });

  it('does not widen a read-only login when the client asks to write', async () => {
    const { tokens } = await logIn(LOGIN_RO, 'vault:read vault:write');

    expect(tokens.scope).toBe('vault:read');
  });

  it('keeps the access level across a token refresh', async () => {
    const { tokens } = await logIn(LOGIN_RO);

    const refreshed = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.scope).toBe('vault:read');
  });

  it('tells a read-only user on the consent page that nothing can be modified', async () => {
    const { consentHtml } = await logIn(LOGIN_RO);

    expect(consentHtml).toContain('Read-only access');
    expect(consentHtml).not.toContain('Modify your notes');
  });

  it('tells a read-write user on the consent page that notes can be modified', async () => {
    const { consentHtml } = await logIn(LOGIN_RW);

    expect(consentHtml).toContain('Modify your notes');
    expect(consentHtml).not.toContain('Read-only access');
  });

  it('advertises the supported scopes in discovery', async () => {
    const metadata = await request(app).get('/.well-known/oauth-authorization-server');

    expect(metadata.body.scopes_supported).toEqual(['vault:read', 'vault:write']);
  });
});

describe('switching the login token mid-authorization', () => {
  const startAuthorization = async () => {
    const authorize = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: PKCE,
      code_challenge_method: 'plain',
      state: 'state-1',
    });
    return new URL(authorize.headers.location, 'http://localhost').searchParams.get('s')!;
  };

  const tokenFor = async (sessionRef: string) => {
    const approve = await request(app).post('/oauth/approve').type('form').send({ s: sessionRef });
    const code = new URL(approve.headers.location).searchParams.get('code')!;
    const token = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: PKCE,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    return token.body as TokenResponse;
  };

  it('lets a read-only login be replaced by a read-write one, keeping the pending request', async () => {
    const first = await startAuthorization();
    await request(app).post('/login').type('form').send({ token: LOGIN_RO, s: first });

    const switched = await request(app).post('/oauth/switch').type('form').send({ s: first });
    const second = new URL(switched.headers.location, 'http://localhost').searchParams.get('s')!;
    await request(app).post('/login').type('form').send({ token: LOGIN_RW, s: second });
    const tokens = await tokenFor(second);

    expect(switched.status).toBe(302);
    expect(second).not.toBe(first);
    expect(tokens.scope).toBe('vault:read vault:write');
  });

  it('invalidates the session it replaces', async () => {
    const first = await startAuthorization();
    await request(app).post('/login').type('form').send({ token: LOGIN_RO, s: first });
    await request(app).post('/oauth/switch').type('form').send({ s: first });

    const consent = await request(app).get('/oauth/consent').query({ s: first });
    const approve = await request(app).post('/oauth/approve').type('form').send({ s: first });

    expect(consent.status).toBe(302);
    expect(approve.headers.location).not.toContain('code=');
  });

  it('requires a fresh login: the new session is not authenticated', async () => {
    const first = await startAuthorization();
    await request(app).post('/login').type('form').send({ token: LOGIN_RW, s: first });
    const switched = await request(app).post('/oauth/switch').type('form').send({ s: first });
    const second = new URL(switched.headers.location, 'http://localhost').searchParams.get('s')!;

    const consent = await request(app).get('/oauth/consent').query({ s: second });

    expect(consent.status).toBe(302);
    expect(consent.headers.location).toContain('/login');
  });

  it('shows which kind of token is signed in, with a way to change it', async () => {
    const { consentHtml } = await logIn(LOGIN_RO);

    expect(consentHtml).toContain('Signed in with a <strong>read-only</strong> token');
    expect(consentHtml).toContain('/oauth/switch');
  });
});

describe('a read-only credential', () => {
  it('is offered only read-only tools, from an OAuth token', async () => {
    const { tokens } = await logIn(LOGIN_RO);
    const sessionId = await openSession(tokens.access_token);

    expect(await listTools(tokens.access_token, sessionId)).toEqual(READ_SESSION_TOOLS);
  });

  it('is offered only read-only tools, from a static bearer token', async () => {
    const sessionId = await openSession(STATIC_RO);

    expect(await listTools(STATIC_RO, sessionId)).toEqual(READ_SESSION_TOOLS);
  });

  it('can read a note', async () => {
    const sessionId = await openSession(STATIC_RO);

    const res = await callTool(STATIC_RO, sessionId, 'read-note', { path: 'Home.md' });

    expect(res.body.result.isError).toBeFalsy();
    expect(res.body.result.content[0].text).toContain('# Home');
  });

  it('cannot call a write tool, and the vault is unchanged', async () => {
    const sessionId = await openSession(STATIC_RO);

    const res = await callTool(STATIC_RO, sessionId, 'create-note', {
      path: 'Sneaky.md',
      content: 'should not exist',
    });

    expect(res.body.error ?? res.body.result?.isError).toBeTruthy();
    expect(await vault.fileExists('Sneaky.md')).toBe(false);
  });

  it('is still narrowed by EXPOSED_TOOLS', async () => {
    process.env.EXPOSED_TOOLS = 'read-note,create-note';
    const sessionId = await openSession(STATIC_RO);

    expect(await listTools(STATIC_RO, sessionId)).toEqual(['orient', 'read-note']);
  });
});

describe('a read-write credential', () => {
  it('is offered the write tools and can use them', async () => {
    const sessionId = await openSession(STATIC_RW);

    const tools = await listTools(STATIC_RW, sessionId);
    const res = await callTool(STATIC_RW, sessionId, 'create-note', {
      path: 'Allowed.md',
      content: 'written',
    });

    expect(tools).toContain('create-note');
    expect(tools).toContain('delete-note');
    expect(res.body.result.isError).toBeFalsy();
    expect(await vault.readFile('Allowed.md')).toBe('written');
  });

  it('can write through an OAuth token too', async () => {
    const { tokens } = await logIn(LOGIN_RW);
    const sessionId = await openSession(tokens.access_token);

    const res = await callTool(tokens.access_token, sessionId, 'create-note', {
      path: 'ViaOAuth.md',
      content: 'written',
    });

    expect(res.body.result.isError).toBeFalsy();
    expect(await vault.fileExists('ViaOAuth.md')).toBe(true);
  });
});

describe('sessions are bound to the access level that opened them', () => {
  it('refuses a read-only token presenting a read-write session id', async () => {
    const writeSession = await openSession(STATIC_RW);

    const res = await callTool(STATIC_RO, writeSession, 'create-note', {
      path: 'Escalated.md',
      content: 'should not exist',
    });

    expect(res.status).toBe(403);
    expect(await vault.fileExists('Escalated.md')).toBe(false);
  });

  it('refuses a read-write token presenting a read-only session id', async () => {
    const readSession = await openSession(STATIC_RO);

    const res = await mcpPost(
      STATIC_RW,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      readSession,
    );

    expect(res.status).toBe(403);
  });
});

describe('ambiguous configuration fails closed', () => {
  it('treats a static token listed at both levels as read-only', async () => {
    process.env.MCP_STATIC_BEARER_TOKENS = `${STATIC_RW},shared`;
    process.env.MCP_STATIC_BEARER_TOKENS_RO = 'shared';
    const sessionId = await openSession('shared');

    expect(await listTools('shared', sessionId)).toEqual(READ_SESSION_TOOLS);
  });

  it('treats identical login tokens as read-only', async () => {
    process.env.PERSONAL_AUTH_TOKEN_RO = LOGIN_RW;

    const { tokens } = await logIn(LOGIN_RW);

    expect(tokens.scope).toBe('vault:read');
  });

  it('still rejects an unknown bearer token', async () => {
    const res = await mcpPost('not-a-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(401);
  });
});

describe('read-only access is enforced by two independent layers', () => {
  it('is held by the vault guard alone when a write tool reaches a read session', async () => {
    readSessions = { guardVault: true, filterTools: false };
    app = buildApp();
    const sessionId = await openSession(STATIC_RO);

    const res = await callTool(STATIC_RO, sessionId, 'create-note', {
      path: 'Backstop.md',
      content: 'should not exist',
    });

    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain(READ_ONLY_ERROR);
    expect(await vault.fileExists('Backstop.md')).toBe(false);
  });

  it('is held by tool filtering alone when the vault guard is absent', async () => {
    readSessions = { guardVault: false, filterTools: true };
    app = buildApp();
    const sessionId = await openSession(STATIC_RO);

    await callTool(STATIC_RO, sessionId, 'create-note', { path: 'NoGuard.md', content: 'x' });

    expect(await vault.fileExists('NoGuard.md')).toBe(false);
  });

  it('would let the write through with both layers removed', async () => {
    // Proves the two tests above are measuring the layers, not something else
    // that happens to block the write.
    readSessions = { guardVault: false, filterTools: false };
    app = buildApp();
    const sessionId = await openSession(STATIC_RO);

    await callTool(STATIC_RO, sessionId, 'create-note', { path: 'Unprotected.md', content: 'x' });

    expect(await vault.fileExists('Unprotected.md')).toBe(true);
  });
});
