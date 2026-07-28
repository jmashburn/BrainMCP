/**
 * Note Conventions
 *
 * Vaults carry conventions — frontmatter, filename casing, templates — that a
 * capable model follows when told and a weaker one silently doesn't. Anything
 * left to the client degrades the vault over time, so the structural parts are
 * generated here and a malformed note simply isn't expressible.
 *
 * Templates are read from the vault at runtime rather than hardcoded, so the
 * vault stays the single source of truth: editing a template changes what the
 * server writes, with no code change and nothing to drift.
 */

export type FrontmatterValue = string | string[];
export type FrontmatterFields = Record<string, FrontmatterValue | undefined>;

export interface ParsedNote {
  frontmatter: Record<string, string>;
  body: string;
  hasFrontmatter: boolean;
}

const FENCE = '---';

/**
 * Split a note into frontmatter and body.
 *
 * Deliberately a line scanner rather than a YAML parse: the goal is to preserve
 * whatever the human wrote byte-for-byte, and a real parser would normalise
 * quoting, key order, and comments on every write.
 */
export function parseFrontmatter(content: string): ParsedNote {
  const lines = content.split('\n');

  if (lines[0] !== FENCE) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  let end = 1;
  while (end < lines.length && lines[end] !== FENCE) end++;

  if (end >= lines.length) {
    // Unterminated fence — treat the whole file as body rather than guess.
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2];
  }

  return {
    frontmatter,
    body: lines.slice(end + 1).join('\n'),
    hasFrontmatter: true,
  };
}

function formatValue(value: FrontmatterValue): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : value;
}

export function renderFrontmatter(fields: FrontmatterFields): string {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined && v !== '');
  const lines = entries.map(([k, v]) => `${k}: ${formatValue(v as FrontmatterValue)}`);
  return [FENCE, ...lines, FENCE, ''].join('\n');
}

/**
 * Add missing frontmatter keys without disturbing ones already present.
 *
 * `overwrite` names keys that should be replaced even when set — 'updated' is
 * the usual case, since a stale updated date is worse than none.
 */
export function ensureFrontmatter(
  content: string,
  fields: FrontmatterFields,
  overwrite: string[] = [],
): string {
  const parsed = parseFrontmatter(content);
  const merged: FrontmatterFields = { ...parsed.frontmatter };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    if (merged[key] === undefined || overwrite.includes(key)) {
      merged[key] = value;
    }
  }

  const body = parsed.hasFrontmatter ? parsed.body : content;
  return renderFrontmatter(merged) + body;
}

/**
 * Expand {{placeholders}} in a template. Unknown placeholders are left intact
 * so a half-filled template is visibly incomplete rather than silently blanked.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

/**
 * Title Case for note names, per the vault convention.
 *
 * Only fully-lowercase words are capitalised, so acronyms and intercapped
 * names survive: 'MarvinSDK' and 'HomeLab' must not become 'Marvinsdk'.
 */
export function toTitleCase(title: string): string {
  return title
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(word =>
      word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(' ');
}

/** Control characters, which have no place in a filename. */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
}

/**
 * Turn a title into a filename-safe note name (no extension).
 *
 * Path separators are stripped rather than escaped: a title is a title, and
 * letting one introduce a directory is how a "note" ends up outside the folder
 * it was meant for. The path guard would refuse an escape anyway, but failing
 * a capture because someone typed a slash in a title is a poor experience.
 */
export function toNoteFilename(title: string): string {
  const cleaned = stripControlChars(title)
    .replace(/[/\\:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) {
    throw new Error('Title produces an empty filename');
  }

  // Leave room for the extension and a path prefix on stricter filesystems.
  return toTitleCase(cleaned).slice(0, 120).trim();
}

export function formatISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A dated journal bullet: '- 2026-07-28 — summary'.
 *
 * Em dash, matching the convention in existing journals. The summary is
 * flattened to a single line: a multi-line entry breaks the bullet list and
 * turns the following lines into body text outside the section.
 */
export function formatJournalBullet(date: Date, summary: string): string {
  const flattened = summary.replace(/\s*\n\s*/g, ' ').trim();
  return `- ${formatISODate(date)} — ${flattened}`;
}
