import { describe, it, expect } from 'vitest';
import { formatJournalEntry } from '@/services/journal-formatter';

describe('formatJournalEntry', () => {
  it('formats the entry with headings, tags, and optional fields', () => {
    const timestamp = new Date('2024-03-20T18:30:00Z');

    const output = formatJournalEntry({
      timestamp,
      activityType: 'development',
      summary: 'Shipped the new search feature.',
      keyTopics: ['TypeScript', 'Vitest'],
      outputs: ['tests/behavior/files.spec.ts'],
      project: 'Projects/Testing Strategy',
    });

    expect(output).toContain('### 6:30 PM - Development');
    expect(output).toContain('**Topics:** #typescript #vitest');
    expect(output).toContain('**Outputs:** tests/behavior/files.spec.ts');
    expect(output).toContain('**Project:** [[Projects/Testing Strategy]]');
  });
});

describe('formatJournalEntry with bullet style', () => {
  const timestamp = new Date('2026-07-28T18:30:00Z');

  it('renders a single dated bullet', () => {
    const output = formatJournalEntry(
      {
        timestamp,
        activityType: 'development',
        summary: 'Wired up the convention layer.',
        keyTopics: ['MCP', 'Obsidian'],
      },
      'bullet',
    );

    expect(output).toBe('- 2026-07-28 — Wired up the convention layer.\n');
  });

  it('omits the section furniture the detailed style adds', () => {
    const output = formatJournalEntry(
      { timestamp, activityType: 'research', summary: 'Read the spec.', keyTopics: ['mcp'] },
      'bullet',
    );

    expect(output).not.toContain('###');
    expect(output).not.toContain('**Topics:**');
    expect(output).not.toContain('---');
  });

  it('still defaults to the detailed style', () => {
    const output = formatJournalEntry({
      timestamp,
      activityType: 'development',
      summary: 'x',
      keyTopics: [],
    });

    expect(output).toContain('### 6:30 PM - Development');
  });
});
