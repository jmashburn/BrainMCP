/**
 * Vault Factory
 *
 * Single place where a VaultManager is built, so the path guard cannot be
 * wired into one entry point and forgotten in another. stdio, http, and lambda
 * all go through here.
 */

import { GitVaultManager } from './git-vault-manager';
import { guardVaultManager, parseProtectedPaths } from './path-guard';
import { guidanceFiles } from './vault-conventions';
import type { VaultManager } from './vault-manager';
import { logger } from '@/utils/logger';

/**
 * Paths refused for writes when VAULT_PROTECTED_PATHS is unset.
 *
 * Default-on rather than opt-in: a vault whose agent instructions and commit
 * hooks are writable by a remote client has no meaningful protection, and an
 * operator who never reads the docs is exactly the one who needs the default.
 */
import { BRAIN_PROTOCOL_PATH } from '@/mcp/brain-protocol';

export const DEFAULT_PROTECTED_PATHS = [
  'CLAUDE.md',
  'AGENTS.md',
  '.githooks/**',
  '.github/**',
  '.gitignore',
  '.gitattributes',
  // The vault-authored agent protocol: clients read it as authoritative
  // guidance, so they must not be able to rewrite it through the server.
  // Humans still edit it in Obsidian (that push bypasses this MCP-write guard).
  BRAIN_PROTOCOL_PATH,
];

export function createVaultManager(vaultPath: string): VaultManager {
  const base = new GitVaultManager({
    repoUrl: process.env.VAULT_REPO!,
    branch: process.env.VAULT_BRANCH!,
    gitToken: process.env.GIT_TOKEN!,
    gitUsername: process.env.GIT_USERNAME,
    vaultPath,
    hooksPath: process.env.VAULT_HOOKS_PATH,
  });

  const configured = parseProtectedPaths(process.env.VAULT_PROTECTED_PATHS);
  const basePaths = configured.length > 0 ? configured : DEFAULT_PROTECTED_PATHS;

  // Whatever files the vault publishes as its guidance are, by definition, the
  // ones a client must not rewrite: they are the rules every other client
  // follows. Protecting them separately from naming them would mean the two
  // lists drift, and the failure is silent — guidance stays readable and
  // quietly becomes writable.
  const protectedPaths = Array.from(new Set([...basePaths, ...guidanceFiles()]));

  logger.info('Vault protection enabled', {
    protectedPaths,
    source: configured.length > 0 ? 'VAULT_PROTECTED_PATHS' : 'default',
    hooksPath: process.env.VAULT_HOOKS_PATH ?? '(none)',
  });

  return guardVaultManager(base, protectedPaths);
}
