/**
 * Journal Entry Formatting
 *
 * Formats journal entries for the log-journal-entry tool
 */

import { formatJournalBullet } from './note-conventions';

export interface JournalEntryData {
  timestamp: Date;
  activityType:
    | 'development'
    | 'research'
    | 'writing'
    | 'planning'
    | 'learning'
    | 'problem-solving';
  summary: string;
  keyTopics: string[];
  outputs?: string[];
  project?: string;
}

/**
 * How a journal entry is rendered.
 *
 * 'detailed' is the original: a timestamped subheading with topics, outputs
 * and project. 'bullet' is a single dated line, for vaults whose journals are
 * a running list rather than a set of sections. The default stays 'detailed'
 * so existing deployments are unaffected.
 */
export type JournalEntryStyle = 'detailed' | 'bullet';

/**
 * Format a journal entry in Obsidian markdown format
 */
export function formatJournalEntry(
  data: JournalEntryData,
  style: JournalEntryStyle = 'detailed',
): string {
  if (style === 'bullet') {
    return formatJournalBullet(data.timestamp, data.summary) + '\n';
  }

  const time = formatTime(data.timestamp);
  const activityLabel = capitalizeFirst(data.activityType);

  const lines: string[] = [];

  lines.push(`### ${time} - ${activityLabel}`);
  lines.push(data.summary);
  lines.push('');

  if (data.keyTopics.length > 0) {
    const topicTags = data.keyTopics.map(t => `#${sanitizeTag(t)}`).join(' ');
    lines.push(`**Topics:** ${topicTags}`);
  }

  if (data.outputs && data.outputs.length > 0) {
    const outputsList = data.outputs.join(', ');
    lines.push(`**Outputs:** ${outputsList}`);
  }

  if (data.project) {
    lines.push(`**Project:** [[${data.project}]]`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format time as HH:MM AM/PM (using UTC time)
 */
function formatTime(date: Date): string {
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();

  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, '0');

  return `${displayHours}:${displayMinutes} ${ampm}`;
}

/**
 * Capitalize first letter
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Sanitize a string for use as an Obsidian tag
 * - Replace spaces with hyphens
 * - Remove special characters
 * - Convert to lowercase
 */
function sanitizeTag(str: string): string {
  return str
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-\/]/g, '');
}
