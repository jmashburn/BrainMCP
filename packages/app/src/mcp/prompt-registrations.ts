/**
 * Prompt registrations.
 *
 * One real prompt, which also makes `prompts/list` answer instead of
 * returning -32601. Some clients (ChatGPT desktop, Codex) probe prompts and
 * resources during their availability check and report a server with no
 * handler as having no tools at all.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'recall-context',
    {
      title: 'Recall vault context',
      description:
        'Pull relevant context for a topic from the vault before answering: read the vault guidelines, search, read the matching notes, summarize.',
      argsSchema: { topic: z.string().describe('What the conversation is about') },
    },
    ({ topic }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Recall what the vault knows about: ${topic}`,
              '',
              '1. Read the resource obsidian://vault-readme for how the vault is organised.',
              '2. Use search-vault on the topic (and obvious synonyms).',
              '3. read-note the best matches — project, system and people notes first, then recent 70-Journal entries.',
              '4. Summarise the durable facts, open tasks and decisions, citing note names.',
              '5. When the conversation produces something worth keeping, use log-journal-entry.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
