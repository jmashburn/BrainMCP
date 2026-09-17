/**
 * Prompt registrations.
 *
 * `brain-orient` points the client at the canonical protocol resource and,
 * given an optional topic, tells it to pull relevant context before asking
 * questions the vault may already answer. The detailed rules live in the vault
 * (see brain://protocol), not here — this prompt stays short on purpose.
 *
 * Registering at least one prompt also makes `prompts/list` answer instead of
 * returning -32601, which some clients treat as the server being unavailable.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BRAIN_PROTOCOL_URI } from '@/mcp/brain-protocol';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'brain-orient',
    {
      title: 'Orient to the Brain',
      description:
        'Read the vault protocol and, for a given topic, pull relevant Brain ' +
        'context before answering. Prefer the `orient` tool if this client ' +
        'does not consume MCP prompts automatically.',
      argsSchema: { topic: z.string().optional().describe('What the work is about (optional)') },
    },
    ({ topic }) => {
      const lines = [
        `Read the resource ${BRAIN_PROTOCOL_URI} and follow it — it is the`,
        'canonical protocol for how this vault is organised and how to write back.',
      ];
      if (topic && topic.trim()) {
        lines.push(
          '',
          `Then, before asking about "${topic}", retrieve what the Brain already`,
          'knows: search for the topic and obvious synonyms, read the best',
          'matching home notes, and summarise the durable facts, open tasks, and',
          'decisions, citing note paths. Only ask once the vault has been checked.',
        );
      }
      return {
        messages: [{ role: 'user', content: { type: 'text', text: lines.join('\n') } }],
      };
    },
  );
}
