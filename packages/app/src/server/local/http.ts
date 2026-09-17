#!/usr/bin/env node
/**
 * Local HTTP Server with OAuth 2.0
 *
 * Provides full OAuth 2.0 Authorization Code Flow with PKCE
 * Uses in-memory session storage
 * Compatible with ChatGPT and Claude
 *
 * Usage:
 *   npm run dev:http
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { createVaultManager } from '@/services/vault-factory';
import { registerTools } from '@/mcp/tool-registrations';
import { registerResources } from '@/mcp/resource-registrations';
import { registerPrompts } from '@/mcp/prompt-registrations';
import { registerConnectorTools } from '@/mcp/connector-tools';
import { registerOrientTool } from '@/mcp/orient-tool';
import { registerOAuthRoutes } from '@/server/shared/oauth-routes';
import { registerMcpRoute } from '@/server/shared/mcp-routes';
import { createInMemoryAuthStore } from '@/services/auth/stores';
import { setAuthStore } from '@/services/auth';
import { loadEnv, ensureEnvVars } from '@/env';
import { logger } from '@/utils/logger';
import { MCP_SERVER_INSTRUCTIONS } from '@/server/shared/instructions';
import { configureLogger } from '@/utils/logger';

loadEnv();

configureLogger({
  stream: process.stdout,
  minLevel: (process.env.LOG_LEVEL as any) || 'info',
});

try {
  ensureEnvVars();
} catch (error: any) {
  console.error('✗ Invalid environment configuration: %s', error.message);
  console.error('  Create a .env file (see .env.example) or export variables.');
  process.exit(1);
}

setAuthStore(createInMemoryAuthStore());

const LOCAL_VAULT_PATH = process.env.LOCAL_VAULT_PATH || './vault-local';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'obsidian-mcp-client';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

if (!OAUTH_CLIENT_SECRET) {
  console.error('✗ OAUTH_CLIENT_SECRET is required!');
  console.error('  Set it in .env or environment variables');
  process.exit(1);
}

const vaultManager = createVaultManager(LOCAL_VAULT_PATH);

// One server per MCP session (see registerMcpRoute's stateful mode); the
// vault manager is shared, so all sessions see the same clone.
const createServer = (): McpServer => {
  const server = new McpServer({
    name: 'obsidian-mcp',
    version: '1.0.0',
    instructions: MCP_SERVER_INSTRUCTIONS,
  });
  registerTools(server, () => vaultManager);
  registerResources(server, () => vaultManager);
  registerPrompts(server);
  registerConnectorTools(server, () => vaultManager);
  registerOrientTool(server, () => vaultManager);
  return server;
};
const mcpServer = createServer();

const app = express();
// Request log: every request, with status, so a client that gives up after
// one message leaves a trail (method, path, status, accept, user-agent).
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    logger.info('HTTP', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
      accept: req.headers.accept,
      ua: (req.headers['user-agent'] || '').slice(0, 60),
      hasAuth: Boolean(req.headers.authorization),
      mcpVersion: req.headers['mcp-protocol-version'],
      hasSession: Boolean(req.headers['mcp-session-id']),
    });
  });
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

registerOAuthRoutes(app, {
  clientId: OAUTH_CLIENT_ID,
  clientSecret: OAUTH_CLIENT_SECRET,
  baseUrl: BASE_URL,
});

registerMcpRoute(app, mcpServer, { createServer });

// Unmatched routes: log them. A client pointed at the wrong path (e.g. the
// site root instead of /mcp) otherwise fails with an unlogged 404.
app.use((req, res) => {
  logger.warn('Unmatched route', { method: req.method, path: req.path });
  res.status(404).json({ error: 'not_found', error_description: `No route for ${req.method} ${req.path}` });
});

const PORT = parseInt(process.env.PORT || '3000');

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  Obsidian MCP Server (OAuth 2.0 Protected)               ║
╠═══════════════════════════════════════════════════════════╣
║  Server:     ${BASE_URL.padEnd(49)}║
║  Vault:      ${LOCAL_VAULT_PATH.padEnd(49)}║
║  Client ID:  ${OAUTH_CLIENT_ID.padEnd(49)}║
╚═══════════════════════════════════════════════════════════╝

OAuth 2.0 Endpoints:
  Authorization: ${BASE_URL}/oauth/authorize
  Token:         ${BASE_URL}/oauth/token
  Register:      ${BASE_URL}/oauth/register
  Revoke:        ${BASE_URL}/oauth/revoke
  Discovery:     ${BASE_URL}/.well-known/oauth-authorization-server

MCP Endpoint (requires Bearer token):
  POST ${BASE_URL}/mcp

Health Check:
  GET ${BASE_URL}/health

Configure ChatGPT/Claude with:
  - Client ID: ${OAUTH_CLIENT_ID}
  - Client Secret: ${OAUTH_CLIENT_SECRET}
  - Authorization URL: ${BASE_URL}/oauth/authorize
  - Token URL: ${BASE_URL}/oauth/token
  `);
});
