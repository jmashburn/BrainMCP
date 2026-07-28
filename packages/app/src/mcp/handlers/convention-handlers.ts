/**
 * Convention-aware handlers.
 *
 * These take typed parameters and render the note themselves, rather than
 * accepting a path and a blob. The client supplies prose; structure — path,
 * filename casing, frontmatter, template — is the server's job, so a note that
 * violates the vault's conventions is not something a client can express.
 */

import type { VaultManager } from '@/services/vault-manager';
import type { VaultConventionsConfig } from '@/services/vault-conventions';
import type { ToolResponse } from './types';
import {
  ensureFrontmatter,
  formatISODate,
  renderTemplate,
  toNoteFilename,
} from '@/services/note-conventions';

function ok(data: unknown, affected: string[]): ToolResponse {
  return {
    success: true,
    data,
    metadata: { timestamp: new Date().toISOString(), affected_files: affected },
  };
}

function fail(error: unknown): ToolResponse {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    metadata: { timestamp: new Date().toISOString() },
  };
}

async function readTemplate(
  vault: VaultManager,
  config: VaultConventionsConfig,
  templateName: string | undefined,
): Promise<string | undefined> {
  if (!templateName) return undefined;

  const templatePath = `${config.templatesDir}/${templateName}`;
  // A missing template is not fatal: capture still succeeds with generated
  // frontmatter. Losing a thought because a template was renamed would be a
  // worse failure than a slightly plainer note.
  if (!(await vault.fileExists(templatePath))) return undefined;

  return vault.readFile(templatePath);
}

/**
 * Capture a note into the inbox, built from the vault's own template.
 */
export async function handleCaptureInbox(
  vault: VaultManager,
  args: { title: string; body: string; tags?: string[] },
  config: VaultConventionsConfig,
  now: Date = new Date(),
): Promise<ToolResponse> {
  try {
    const filename = toNoteFilename(args.title);
    const path = `${config.inboxDir}/${filename}.md`;

    if (await vault.fileExists(path)) {
      throw new Error(
        `A note already exists at ${path}. Capture uses the title as the filename; ` +
          `choose a different title or edit the existing note.`,
      );
    }

    const date = formatISODate(now);
    const template = await readTemplate(vault, config, config.inboxTemplate);

    const base = template
      ? renderTemplate(template, { date, title: args.title, body: args.body })
      : `# ${args.title}\n\n${args.body}\n`;

    // A template may already carry frontmatter; ensureFrontmatter fills only
    // what is missing so the template stays authoritative.
    const content = ensureFrontmatter(base, {
      type: 'reference',
      created: date,
      updated: date,
      tags: args.tags,
      source: config.source,
      via: 'brain-mcp',
    });

    await vault.writeFile(path, content);

    return ok({ success: true, path, title: args.title }, [path]);
  } catch (error) {
    return fail(error);
  }
}

/**
 * Add a task under a heading in the vault's task list.
 */
export async function handleAddTask(
  vault: VaultManager,
  args: { text: string; section?: string },
  config: VaultConventionsConfig,
  now: Date = new Date(),
): Promise<ToolResponse> {
  try {
    const section = args.section ?? config.tasksDefaultSection;
    const heading = section.startsWith('#') ? section : `## ${section}`;

    if (!(await vault.fileExists(config.tasksPath))) {
      throw new Error(
        `Task list not found at ${config.tasksPath}. Set TASKS_PATH to the vault's task note.`,
      );
    }

    const content = await vault.readFile(config.tasksPath);
    const lines = content.split('\n');

    const headingIndex = lines.findIndex(
      line => line.trim().toLowerCase() === heading.trim().toLowerCase(),
    );
    if (headingIndex === -1) {
      const available = lines.filter(l => /^#{1,6}\s/.test(l)).map(l => l.trim());
      throw new Error(
        `Section "${heading}" not found in ${config.tasksPath}. Available: ${available.join(', ')}`,
      );
    }

    const entry = `- [ ] ${args.text.replace(/\s*\n\s*/g, ' ').trim()} (${formatISODate(now)})`;

    // Insert after the last existing task in the section, so ordering reflects
    // when things were added. Stop at the next heading — appending past it
    // would silently file the task under the wrong section.
    let insertAt = headingIndex + 1;
    let lastTask = -1;
    for (let i = headingIndex + 1; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i])) break;
      if (/^\s*-\s\[[ xX]\]/.test(lines[i])) lastTask = i;
      insertAt = i + 1;
    }
    const position = lastTask >= 0 ? lastTask + 1 : headingIndex + 1;

    // A placeholder like "_(nothing yet)_" is noise once a real task exists.
    const placeholderIndex = lines.findIndex(
      (l, i) => i > headingIndex && i < insertAt && /^_\(.*\)_$/.test(l.trim()),
    );

    lines.splice(position, 0, entry);
    if (placeholderIndex >= 0) {
      lines.splice(placeholderIndex > position ? placeholderIndex + 1 : placeholderIndex, 1);
    }

    await vault.writeFile(config.tasksPath, lines.join('\n'));

    return ok({ success: true, path: config.tasksPath, section: heading, entry }, [
      config.tasksPath,
    ]);
  } catch (error) {
    return fail(error);
  }
}
