/**
 * Tool Allowlist
 *
 * Upstream registers all tools unconditionally. That is reasonable for a local
 * stdio server driven by one trusted client, and wrong for an HTTP server
 * reachable from the internet and driven by whichever model a vendor ships:
 * `delete-note` and `move-note` are destructive and rarely needed remotely.
 *
 * EXPOSED_TOOLS is an allowlist of tool names. Unset means "register
 * everything", preserving existing behaviour.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger, isLoggerConfigured } from '@/utils/logger';

/** McpServer.registerTool, widened so the proxy can forward arbitrary arg shapes. */
type RegisterToolFn = (name: string, ...rest: unknown[]) => unknown;

export function parseExposedTools(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw.trim() === '') return null;

  const names = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  return names.length > 0 ? new Set(names) : null;
}

/**
 * Wrap an McpServer so registerTool silently skips tools outside the allowlist.
 *
 * A skipped tool is absent from tools/list, not merely refused on call — a tool
 * the model cannot see is one it cannot be talked into using.
 */
export function applyToolAllowlist(server: McpServer, raw = process.env.EXPOSED_TOOLS): McpServer {
  const allowed = parseExposedTools(raw);

  if (!allowed) return server;

  const registered: string[] = [];
  const skipped: string[] = [];

  const proxy = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);

      return (name: string, ...rest: unknown[]) => {
        if (!allowed.has(name)) {
          skipped.push(name);
          return undefined;
        }
        registered.push(name);
        return (target.registerTool as RegisterToolFn).call(target, name, ...rest);
      };
    },
  });

  // Report after registration so the counts are real rather than intended.
  // Guarded: tool registration also runs under the test harness, which has no
  // logger configured, and diagnostics must never be the reason a caller fails.
  queueMicrotask(() => {
    if (!isLoggerConfigured()) return;
    const unknown = [...allowed].filter(n => !registered.includes(n));
    logger.info('Tool allowlist applied', { registered, skipped });
    if (unknown.length > 0) {
      // Almost always a typo in EXPOSED_TOOLS, which would otherwise present
      // as a tool mysteriously missing from the client.
      logger.warn('EXPOSED_TOOLS names no such tool', { unknown });
    }
  });

  return proxy;
}
