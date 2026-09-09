/**
 * ChatGPT connector tools.
 *
 * Outside Developer mode, a ChatGPT conversation is only given MCP tools named
 * `search` and `fetch`, with a fixed response contract, and refuses a server
 * that lacks either. These wrap the vault's existing search and read handlers
 * so the same server works in both modes.
 *
 * Contract (developers.openai.com/api/docs/mcp):
 *   search(query)  -> text: JSON { results: [{ id, title, url }] }
 *   fetch(id)      -> text: JSON { id, title, text, url, metadata }
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { VaultManager } from '@/services/vault-manager';
import * as handlers from '@/mcp/handlers';

const SEARCH_LIMIT = 20;

function titleOf(path: string): string {
  return path.replace(/\.md$/i, '').split('/').pop() || path;
}

function urlOf(path: string): string {
  const vault = process.env.CONNECTOR_VAULT_NAME || 'vault';
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerConnectorTools(
  server: McpServer,
  getVaultManager: () => VaultManager,
): void {
  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Search the vault (filenames and content). Returns matching notes as results with an id to pass to fetch.',
      inputSchema: { query: z.string().describe('Search query') },
      annotations: readOnly,
    },
    async ({ query }) => {
      const result = await handlers.handleSearchVault(getVaultManager(), {
        query,
        limit: SEARCH_LIMIT,
      });
      const items: Array<{ path: string; matches?: Array<{ content: string }> }> = result.success
        ? (result.data?.results ?? [])
        : [];
      const results = items.map((item) => ({
        id: item.path,
        title: titleOf(item.path),
        url: urlOf(item.path),
        text: item.matches?.[0]?.content?.slice(0, 200),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
    },
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch',
      description: 'Fetch the full contents of a note by the id returned from search (its vault path).',
      inputSchema: { id: z.string().describe('Note id (vault-relative path) from search') },
      annotations: readOnly,
    },
    async ({ id }) => {
      const result = await handlers.handleReadNote(getVaultManager(), { path: id });
      if (!result.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: result.error ?? 'not found', id }) }],
          isError: true,
        };
      }
      const doc = {
        id,
        title: titleOf(id),
        text: result.data?.content ?? '',
        url: urlOf(id),
        metadata: { path: id, source: 'obsidian-vault' },
      };
      return { content: [{ type: 'text', text: JSON.stringify(doc) }] };
    },
  );
}
