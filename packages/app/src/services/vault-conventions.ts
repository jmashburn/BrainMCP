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
