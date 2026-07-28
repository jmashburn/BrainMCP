/**
 * Vault Conventions Config
 *
 * Where the convention-aware tools write, and which templates they fill. All
 * env-driven so the server carries no knowledge of any particular vault's
 * folder names — a different vault is configuration, not a fork.
 */

export interface VaultConventionsConfig {
  /** Folder holding note templates, e.g. '90-Meta/templates'. */
  templatesDir: string;
  /** Folder for quick capture, e.g. '00-Inbox'. */
  inboxDir: string;
  /** Template filled by capture-inbox, relative to templatesDir. */
  inboxTemplate?: string;
  /** Active task list, e.g. '10-Tasks/TASKS.md'. */
  tasksPath: string;
  /** Heading new tasks are added under when none is given, e.g. '## Now'. */
  tasksDefaultSection: string;
  /**
   * Recorded as `source:` in frontmatter of notes this server writes.
   *
   * Provenance matters more here than it looks: a note written by one model is
   * later read by another *as memory*, and memory is trusted. Marking origin
   * lets a reader treat third-party content as data rather than instruction.
   */
  source?: string;
}

export function loadVaultConventionsConfig(
  env: NodeJS.ProcessEnv = process.env,
): VaultConventionsConfig {
  return {
    templatesDir: env.TEMPLATES_DIR ?? 'Templates',
    inboxDir: env.INBOX_DIR ?? 'Inbox',
    inboxTemplate: env.INBOX_TEMPLATE,
    tasksPath: env.TASKS_PATH ?? 'Tasks.md',
    tasksDefaultSection: env.TASKS_DEFAULT_SECTION ?? '## Now',
    source: env.NOTE_SOURCE,
  };
}

/**
 * Files describing how the vault is organised, exposed as a resource so a
 * client can read the conventions before writing — and, for the same reason,
 * refused for writes.
 *
 * Configurable because 'README.md' is only one convention for this: vaults
 * built around an agent commonly use CLAUDE.md or AGENTS.md, and a hardcoded
 * filename silently returns "not found" for all of them, leaving the client
 * with no guidance and no indication any was on offer.
 */
export function guidanceFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.VAULT_GUIDANCE_FILES;
  if (configured && configured.trim() !== '') {
    return configured
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  return ['README.md', 'CLAUDE.md', 'AGENTS.md'];
}
