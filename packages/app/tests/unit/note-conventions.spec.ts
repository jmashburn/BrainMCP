import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  renderFrontmatter,
  ensureFrontmatter,
  renderTemplate,
  toTitleCase,
  toNoteFilename,
  formatISODate,
  formatJournalBullet,
} from '@/services/note-conventions';

describe('parseFrontmatter', () => {
  it('splits frontmatter from body', () => {
    const note = ['---', 'type: system', 'status: active', '---', '', '# Body', 'text'].join('\n');
    const parsed = parseFrontmatter(note);

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter).toEqual({ type: 'system', status: 'active' });
    expect(parsed.body).toBe('\n# Body\ntext');
  });

  it('treats a note without frontmatter as all body', () => {
    const parsed = parseFrontmatter('# Just a heading\n');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe('# Just a heading\n');
  });

  it('treats an unterminated fence as body rather than guessing', () => {
    const parsed = parseFrontmatter('---\ntype: system\n\n# Body');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe('---\ntype: system\n\n# Body');
  });

  it('ignores a --- that appears later in the body', () => {
    const note = ['---', 'type: daily', '---', '', 'a', '---', 'b'].join('\n');
    expect(parseFrontmatter(note).frontmatter).toEqual({ type: 'daily' });
  });
});

describe('renderFrontmatter', () => {
  it('renders scalars and arrays, skipping empties', () => {
    const out = renderFrontmatter({
      type: 'project',
      tags: ['claude', 'vault'],
      status: undefined,
      note: '',
    });

    expect(out).toBe('---\ntype: project\ntags: [claude, vault]\n---\n');
  });
});

describe('ensureFrontmatter', () => {
  it('adds frontmatter to a note that has none', () => {
    const out = ensureFrontmatter('# Title\n\nbody', { type: 'reference', created: '2026-07-28' });

    expect(out).toBe('---\ntype: reference\ncreated: 2026-07-28\n---\n# Title\n\nbody');
  });

  it('does not clobber values the human already set', () => {
    const note = '---\ntype: system\nstatus: archived\n---\nbody';
    const out = ensureFrontmatter(note, { type: 'reference', status: 'active' });

    expect(out).toContain('type: system');
    expect(out).toContain('status: archived');
  });

  it('overwrites only the keys named', () => {
    const note = '---\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\nbody';
    const out = ensureFrontmatter(note, { updated: '2026-07-28' }, ['updated']);

    expect(out).toContain('created: 2026-01-01');
    expect(out).toContain('updated: 2026-07-28');
  });
});

describe('renderTemplate', () => {
  it('expands known placeholders', () => {
    expect(
      renderTemplate('created: {{date}}\n# {{title}}', { date: '2026-07-28', title: 'X' }),
    ).toBe('created: 2026-07-28\n# X');
  });

  it('leaves unknown placeholders intact so a gap is visible', () => {
    expect(renderTemplate('{{date}} {{unknown}}', { date: '2026-07-28' })).toBe(
      '2026-07-28 {{unknown}}',
    );
  });
});

describe('toTitleCase', () => {
  it('capitalises lowercase words', () => {
    expect(toTitleCase('claude brain setup')).toBe('Claude Brain Setup');
  });

  it('preserves acronyms and intercapped names', () => {
    expect(toTitleCase('MarvinSDK notes')).toBe('MarvinSDK Notes');
    expect(toTitleCase('HomeLab')).toBe('HomeLab');
    expect(toTitleCase('ADR review')).toBe('ADR Review');
  });
});

describe('toNoteFilename', () => {
  it('title-cases and keeps spaces, matching the vault convention', () => {
    expect(toNoteFilename('payments service')).toBe('Payments Service');
  });

  it('strips path separators so a title cannot introduce a directory', () => {
    expect(toNoteFilename('foo/bar')).toBe('Foo Bar');
    expect(toNoteFilename('../../etc/passwd')).toBe('.. .. Etc Passwd');
  });

  it('strips Obsidian-hostile and filesystem-hostile characters', () => {
    expect(toNoteFilename('a:b*c?d"e<f>g|h')).toBe('A B C D E F G H');
    expect(toNoteFilename('[[wikilink]]')).toBe('Wikilink');
  });

  it('rejects a title that reduces to nothing', () => {
    expect(() => toNoteFilename('///')).toThrow();
    expect(() => toNoteFilename('   ')).toThrow();
  });

  it('truncates absurdly long titles', () => {
    expect(toNoteFilename('a'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('formatJournalBullet', () => {
  const date = new Date('2026-07-28T17:05:00Z');

  it('formats a dated bullet with an em dash', () => {
    expect(formatJournalBullet(date, 'Wired up the MCP server.')).toBe(
      '- 2026-07-28 — Wired up the MCP server.',
    );
  });

  it('flattens multi-line summaries so the bullet list survives', () => {
    expect(formatJournalBullet(date, 'First line.\n  Second line.')).toBe(
      '- 2026-07-28 — First line. Second line.',
    );
  });
});

describe('formatISODate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(formatISODate(new Date('2026-07-28T23:59:00Z'))).toBe('2026-07-28');
  });
});
