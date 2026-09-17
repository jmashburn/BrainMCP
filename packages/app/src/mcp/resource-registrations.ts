import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultManager } from '@/services/vault-manager';
import { guidanceFiles } from '@/services/vault-conventions';
import { BRAIN_PROTOCOL_URI, BRAIN_PROTOCOL_PATH, readBrainProtocol } from '@/mcp/brain-protocol';

/**
 * Register MCP resources with the server
 *
 * Resources provide contextual information about the vault that LLMs can
 * reference when needed, without loading the data upfront.
 */
export function registerResources(server: McpServer, getVaultManager: () => VaultManager): void {
  server.registerResource(
    'brain-protocol',
    BRAIN_PROTOCOL_URI,
    {
      name: 'Brain protocol',
      description:
        'The canonical agent protocol for this vault, authored in the vault ' +
        `itself (${BRAIN_PROTOCOL_PATH}). How to orient, what goes where, ` +
        'conventions, and the write-back rules. Read this first for substantive work.',
      mimeType: 'text/markdown',
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async uri => {
      const vault = getVaultManager();
      // Deliberately let a missing protocol note throw: the SDK turns it into
      // an MCP error, which is the honest signal. Substituting hard-coded
      // instructions would let the vault and the served protocol drift apart.
      const text = await readBrainProtocol(vault);
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
      };
    },
  );

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
