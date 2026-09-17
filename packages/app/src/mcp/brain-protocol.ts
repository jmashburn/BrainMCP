/**
 * The Brain protocol — the canonical, vault-authored instructions for how an
 * agent should orient to and write back to this vault.
 *
 * The protocol lives in the vault (not in code) so editing the note updates
 * every client without rebuilding the server. This module is the single place
 * that knows where it lives and how to read it; the resource, the prompt, and
 * the `orient` tool all go through here.
 */

import type { VaultManager } from '@/services/vault-manager';

/** Vault-relative path to the canonical protocol note. */
export const BRAIN_PROTOCOL_PATH = '90-Meta/skills/Brain/SKILL.md';

/** Stable URI the protocol is exposed at as an MCP resource. */
export const BRAIN_PROTOCOL_URI = 'brain://protocol';

/**
 * Read the current protocol from the vault. Throws if the note is missing so
 * callers surface a clear error rather than substituting stale hard-coded text.
 */
export async function readBrainProtocol(vault: VaultManager): Promise<string> {
  if (!(await vault.fileExists(BRAIN_PROTOCOL_PATH))) {
    throw new Error(
      `Brain protocol note not found at ${BRAIN_PROTOCOL_PATH}. ` +
        `The vault must contain the canonical agent protocol at this path.`,
    );
  }
  return vault.readFile(BRAIN_PROTOCOL_PATH);
}
