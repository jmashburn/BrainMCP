import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultManager } from '@/services/vault-manager';

/**
 * Files describing how the vault is organised, exposed as a resource so a
 * client can read the conventions before writing.
 *
 * Configurable because 'README.md' is only one convention for this — vaults
 * built around an agent commonly use CLAUDE.md or AGENTS.md, and a hardcoded
 * filename silently returns "not found" for all of them, leaving the client
 * with no guidance and no indication any was on offer.
 */
function guidanceFiles(): string[] {
  const configured = process.env.VAULT_GUIDANCE_FILES;
  if (configured && configured.trim() !== '') {
    return configured
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  return ['README.md', 'CLAUDE.md', 'AGENTS.md'];
}

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
