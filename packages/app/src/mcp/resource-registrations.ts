import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultManager } from '@/services/vault-manager';
import { guidanceFiles } from '@/services/vault-conventions';

/**
 * Register MCP resources with the server
 *
 * Resources provide contextual information about the vault that LLMs can
 * reference when needed, without loading the data upfront.
 */
export function registerResources(server: McpServer, getVaultManager: () => VaultManager): void {
  server.registerResource(
    'vault-readme',
    'obsidian://vault-readme',
    {
      name: 'Vault Guidelines',
      description:
        'Vault organization guidelines and structure, from the vault root ' +
        '(README.md / CLAUDE.md / AGENTS.md, or VAULT_GUIDANCE_FILES)',
      mimeType: 'text/markdown',
      annotations: {
        readOnlyHint: true,
        openWorldHint: true, // Interacts with git-backed vault
      },
    },
    async uri => {
      const vault = getVaultManager();
      const candidates = guidanceFiles();

      try {
        const sections: string[] = [];

        // Concatenate rather than take the first match: a vault may split
        // protocol (CLAUDE.md) from conventions (a separate note), and a client
        // that reads only one of them follows half the rules.
        for (const file of candidates) {
          if (await vault.fileExists(file)) {
            const content = await vault.readFile(file);
            sections.push(`<!-- ${file} -->\n\n${content}`);
          }
        }

        if (sections.length === 0) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: 'text/markdown',
                text:
                  `No vault guidelines found. Looked for: ${candidates.join(', ')}. ` +
                  `Set VAULT_GUIDANCE_FILES to point at this vault's guidance notes.`,
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: sections.join('\n\n---\n\n'),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error reading vault guidelines';

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: `Error reading vault guidelines: ${errorMessage}`,
            },
          ],
        };
      }
    },
  );
}
