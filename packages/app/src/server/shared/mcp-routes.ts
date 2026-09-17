/**
 * Shared MCP Routes
 *
 * MCP endpoint handlers used by both local and Lambda HTTP servers
 */

import { Express, Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import * as auth from '@/services/auth';
import { logger } from '@/utils/logger';
import { timingSafeEqual } from 'node:crypto';

/**
 * Static bearer tokens, for clients that can send a fixed Authorization header
 * but cannot complete an OAuth flow. Comma-separated in MCP_STATIC_BEARER_TOKENS.
 * Same trust level as PERSONAL_AUTH_TOKEN: anyone holding one has the vault.
 */
function matchesStaticToken(token: string): boolean {
  const configured = (process.env.MCP_STATIC_BEARER_TOKENS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const given = Buffer.from(token);
  return configured.some((c) => {
    const cand = Buffer.from(c);
    return cand.length === given.length && timingSafeEqual(cand, given);
  });
}

/**
 * Make the tools/list result safe for strict clients (OpenAI's ChatGPT
 * connector runtime). The SDK / zod-to-json-schema stamps each schema with
 * `$schema: draft-07`, which that runtime treats as an invalid parameter
 * schema and silently drops the tool — the connector then shows zero tools.
 * We strip every `$schema` marker and remove the optional `outputSchema`
 * (unsupported there, and only advisory anyway).
 */
function stripSchemaMarker(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripSchemaMarker);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    delete obj['$schema'];
    for (const value of Object.values(obj)) stripSchemaMarker(value);
  }
}

export function sanitizeToolsList(message: unknown): void {
  const result = (message as { result?: { tools?: Array<Record<string, unknown>> } })?.result;
  if (!result?.tools || !Array.isArray(result.tools)) return;
  for (const tool of result.tools) {
    if (tool.inputSchema) stripSchemaMarker(tool.inputSchema);
    if ('outputSchema' in tool) delete tool.outputSchema;
  }
}

/**
 * OAuth middleware to authenticate Bearer tokens
 */
async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn('MCP request rejected: no bearer token', { path: req.path, method: req.method });
    const metadataUrl = `${process.env.BASE_URL || ''}/.well-known/oauth-protected-resource`;
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
    res.status(401).json({
      error: 'unauthorized',
      error_description: 'Missing or invalid Authorization header',
    });
    return;
  }

  const token = authHeader.substring(7);

  if (matchesStaticToken(token)) {
    next();
    return;
  }

  if (!(await auth.validateAccessToken(token))) {
    logger.warn('MCP request rejected: invalid or expired bearer token', {
      path: req.path,
      tokenPrefix: token.slice(0, 4),
      tokenLength: token.length,
      hasWhitespace: /\s/.test(token),
      staticConfigured: (process.env.MCP_STATIC_BEARER_TOKENS || '').length > 0,
    });
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    res.status(401).json({
      error: 'invalid_token',
      error_description: 'Access token is invalid or expired',
    });
    return;
  }

  next();
}

/**
 * Register MCP endpoint on an Express app
 *
 * OAuth authentication is always required for the MCP endpoint.
 *
 * @param app - Express application
 * @param mcpServer - MCP server instance
 */
export interface McpRouteOptions {
  /**
   * When provided, the endpoint runs in stateful session mode: each MCP
   * session gets its own server + transport, identified by `mcp-session-id`,
   * and GET /mcp opens the SSE event stream. Required by clients that treat a
   * 405 on GET as a failed connection (the ChatGPT desktop app does). Lambda
   * stays stateless (no option) because it cannot hold a stream open.
   */
  createServer?: () => McpServer;
}

export function registerMcpRoute(app: Express, mcpServer: McpServer, options: McpRouteOptions = {}): void {
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      oauth: 'enabled',
      vault: process.env.LOCAL_VAULT_PATH || process.env.VAULT_REPO_URL || 'configured',
    });
  });

  if (options.createServer) {
    registerStatefulRoutes(app, options.createServer);
    return;
  }

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      error: 'method_not_allowed',
      error_description: 'SSE streaming is not supported in Lambda',
    });
  });

  const mcpHandler = async (req: Request, res: Response) => {
    const startTime = Date.now();
    const method = req.body?.method || 'unknown';
    const requestId = req.body?.id;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      transport.close();
    });

    try {
      logger.debug('MCP request received', {
        method,
        requestId,
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      logger.info('MCP request completed', {
        method,
        requestId,
        durationMs: Date.now() - startTime,
        success: true,
      });
    } catch (error) {
      logger.error('Error handling MCP request', {
        error,
        method,
        requestId,
        durationMs: Date.now() - startTime,
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: error instanceof Error ? error.message : 'Unknown error',
          },
          id: null,
        });
      }
    }
  };

  app.post('/mcp', authenticateToken, mcpHandler);
}

/**
 * Stateful session mode (local HTTP server).
 *
 * Follows the SDK's reference pattern: an initialize request without a
 * session id creates a transport + server pair; every later request carries
 * `mcp-session-id` and is routed to that pair. GET streams server events,
 * DELETE ends the session.
 */
function registerStatefulRoutes(app: Express, createServer: () => McpServer): void {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const sessionIdOf = (req: Request): string | undefined => {
    const raw = req.headers['mcp-session-id'];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const badSession = (res: Response, message: string) => {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
  };

  app.post('/mcp', authenticateToken, async (req: Request, res: Response) => {
    const startTime = Date.now();
    const method = req.body?.method || 'unknown';
    const requestId = req.body?.id;
    const sid = sessionIdOf(req);

    try {
      let transport = sid ? sessions.get(sid) : undefined;

      if (!transport) {
        if (sid) {
          logger.warn('MCP request for unknown session', { sid: sid.slice(0, 8), method });
          return badSession(res, 'Bad Request: unknown or expired session');
        }
        if (!isInitializeRequest(req.body)) {
          logger.warn('MCP request without session and not initialize', { method });
          return badSession(res, 'Bad Request: no valid session ID provided');
        }

        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, newTransport);
            logger.info('MCP session opened', { sid: id.slice(0, 8), sessions: sessions.size });
          },
        });
        newTransport.onclose = () => {
          const id = newTransport.sessionId;
          if (id && sessions.delete(id)) {
            logger.info('MCP session closed', { sid: id.slice(0, 8), sessions: sessions.size });
          }
        };
        const originalSend = newTransport.send.bind(newTransport);
        newTransport.send = (msg, opts) => {
          sanitizeToolsList(msg);
          return originalSend(msg, opts);
        };
        await createServer().connect(newTransport);
        transport = newTransport;
      }

      await transport.handleRequest(req, res, req.body);
      logger.info('MCP request completed', {
        method,
        requestId,
        durationMs: Date.now() - startTime,
        success: true,
      });
    } catch (error) {
      logger.error('Error handling MCP request', { error, method, requestId });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error', data: error instanceof Error ? error.message : 'Unknown error' },
          id: requestId ?? null,
        });
      }
    }
  });

  const sessionOnly = async (req: Request, res: Response) => {
    const sid = sessionIdOf(req);
    const transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      logger.warn('MCP stream/delete for unknown session', { method: req.method, hasSid: Boolean(sid) });
      return badSession(res, 'Bad Request: unknown or missing session ID');
    }
    await transport.handleRequest(req, res);
  };

  // Some clients (codex-mcp-client, incl. the ChatGPT desktop app) open the
  // GET event stream and send DELETE without the Authorization header they
  // used for POST. A 401 there makes them report "not logged in". A session
  // id is only ever issued to a caller that authenticated its initialize
  // request and is unguessable, so a known session id is accepted as proof.
  const sessionOrToken = async (req: Request, res: Response, next: NextFunction) => {
    const sid = sessionIdOf(req);
    if (sid && sessions.has(sid)) {
      if (!req.headers.authorization) {
        logger.debug('MCP stream/delete authenticated by session id only', { method: req.method, sid: sid.slice(0, 8) });
      }
      return next();
    }
    return authenticateToken(req, res, next);
  };

  app.get('/mcp', sessionOrToken, sessionOnly);
  app.delete('/mcp', sessionOrToken, sessionOnly);
}
