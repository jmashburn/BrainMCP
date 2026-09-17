/**
 * `orient` tool.
 *
 * For clients (ChatGPT and other connector-style hosts) that may never invoke
 * MCP prompts or resources on their own. It returns the canonical Brain
 * protocol plus a right-sized context package so a single tool call is enough
 * to start working correctly.
 *
 * It reuses the existing search/read handlers and the VaultManager, so it
 * inherits the same path guards and protections; it adds no new vault access.
 * Registered on every transport — nothing here is HTTP-specific.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { VaultManager } from '@/services/vault-manager';
import * as handlers from '@/mcp/handlers';
import { readBrainProtocol } from '@/mcp/brain-protocol';

const JARED_NOTE = '50-People/Jared.md';
const TASKS_NOTE = '10-Tasks/TASKS.md';
const JOURNAL_DIR = '70-Journal';
const TOPIC_RESULT_LIMIT = 8;
const RECENT_JOURNALS = 2;
// Cap any single embedded note so orient stays context-sized; the client can
// fetch the full note by path when it needs more.
const NOTE_CHAR_CAP = 4000;

function titleOf(path: string): string {
  return path.replace(/\.md$/i, '').split('/').pop() || path;
}

function clip(text: string, cap = NOTE_CHAR_CAP): string {
  return text.length <= cap
    ? text
    : `${text.slice(0, cap)}\n…(truncated — read the full note by path)`;
}

async function readNoteSafe(vault: VaultManager, path: string): Promise<string | null> {
  const res = await handlers.handleReadNote(vault, { path });
  return res.success ? (res.data?.content ?? '') : null;
}

async function topicHits(
  vault: VaultManager,
  topic: string,
): Promise<Array<{ path: string; title: string; snippet?: string }>> {
  const res = await handlers.handleSearchVault(vault, { query: topic, limit: TOPIC_RESULT_LIMIT });
  const results: Array<{ path: string; matches?: Array<{ content: string }> }> = res.success
    ? (res.data?.results ?? [])
    : [];
  return results.map(r => ({
    path: r.path,
    title: titleOf(r.path),
    snippet: r.matches?.[0]?.content?.trim().slice(0, 200),
  }));
}

async function recentJournals(vault: VaultManager): Promise<string[]> {
  try {
    const files = await vault.listFiles(JOURNAL_DIR, { fileTypes: ['md'] });
    // Daily notes are YYYY-MM-DD.md, so a lexical sort is chronological.
    return files
      .filter(f => /\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, RECENT_JOURNALS);
  } catch {
    return [];
  }
}

export function registerOrientTool(server: McpServer, getVaultManager: () => VaultManager): void {
  server.registerTool(
    'orient',
    {
      title: 'Orient to the Brain',
      description:
        'Start here for substantive Brain work. Returns the vault protocol plus ' +
        'right-sized context. mode "quick" (default) = protocol + the best notes ' +
        'for a topic, for narrow capture/updates. mode "substantive" = also ' +
        'includes Jared, active tasks, and recent journal, for planning or ' +
        'technical work. For a one-off lookup you can also just search/read directly.',
      inputSchema: {
        topic: z.string().optional().describe('What the work is about'),
        mode: z
          .enum(['quick', 'substantive'])
          .optional()
          .describe('quick = narrow lookup/update; substantive = full orientation. Default quick.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ topic, mode }) => {
      const vault = getVaultManager();

      // Missing protocol is a hard, visible error (per brain-protocol.ts).
      const protocol = await readBrainProtocol(vault);

      // Omitted mode defaults to quick: cheapest safe path, avoids excessive
      // reads when the request is ambiguous.
      const resolvedMode: 'quick' | 'substantive' = mode ?? 'quick';

      const sections: string[] = [
        '# Brain orientation',
        `mode: ${resolvedMode}${topic ? ` · topic: ${topic}` : ''}`,
        '',
        '## Protocol (brain://protocol)',
        protocol,
      ];

      if (resolvedMode === 'substantive') {
        const [jared, tasks, journals] = await Promise.all([
          readNoteSafe(vault, JARED_NOTE),
          readNoteSafe(vault, TASKS_NOTE),
          recentJournals(vault),
        ]);
        if (jared !== null)
          sections.push('', `## Who you're working with (${JARED_NOTE})`, clip(jared));
        if (tasks !== null) sections.push('', `## Active tasks (${TASKS_NOTE})`, clip(tasks));
        for (const jpath of journals) {
          const content = await readNoteSafe(vault, jpath);
          if (content !== null)
            sections.push('', `## Recent journal (${jpath})`, clip(content, 2000));
        }
      }

      if (topic && topic.trim()) {
        const hits = await topicHits(vault, topic.trim());
        if (resolvedMode === 'quick') {
          // Quick capture wants the home note in hand: embed the top match,
          // list the rest by path so the client can fetch if needed.
          const top = hits[0];
          if (top) {
            const content = await readNoteSafe(vault, top.path);
            if (content !== null) sections.push('', `## Best match (${top.path})`, clip(content));
          }
          if (hits.length > 1) {
            sections.push(
              '',
              '## Other matches (fetch by path if relevant)',
              ...hits
                .slice(1)
                .map(h => `- ${h.title} — \`${h.path}\`${h.snippet ? ` — ${h.snippet}` : ''}`),
            );
          }
          if (hits.length === 0) {
            sections.push(
              '',
              `## No matches for "${topic}"`,
              'Consider capture-inbox if this is new.',
            );
          }
        } else {
          // Substantive: list relevant notes by path/title so the client
          // pulls what it needs rather than us dumping every match.
          sections.push(
            '',
            `## Relevant notes for "${topic}" (fetch by path)`,
            ...(hits.length
              ? hits.map(h => `- ${h.title} — \`${h.path}\`${h.snippet ? ` — ${h.snippet}` : ''}`)
              : ['- (none found)']),
          );
        }
      }

      return { content: [{ type: 'text', text: sections.join('\n') }] };
    },
  );
}
