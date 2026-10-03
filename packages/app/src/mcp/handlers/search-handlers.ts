import { VaultManager } from '@/services/vault-manager';
import type { ToolResponse } from './types';
import { logger } from '@/utils/logger';

type Relevance = 1 | 2 | 3 | 4;

interface LineMatch {
  line: number;
  content: string;
  context_before: string[];
  context_after: string[];
}

interface SearchResult {
  path: string;
  match_type: 'filename' | 'content';
  relevance_score: Relevance;
  matches?: LineMatch[];
}

/** Rates how well a line or filename matches the query; null means no match. */
type Matcher = (text: string) => Relevance | null;

// Output caps. A broad query used to return every matching line of every note
// with context, which reached hundreds of KB and swamped the caller's context
// window; a search result only has to say where to look, read-note does the rest.
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_LINES_PER_FILE = 3;
export const MAX_LINE_LENGTH = 200;
export const MAX_CONTEXT_LINES = 2;
const TRUNCATION_MARKER = '…';
const READ_BATCH_SIZE = 10;

// A fuzzy (non-substring) word match is allowed when the edit distance is
// under this fraction of the longer word: one typo in a word of 5+ letters,
// two in 9+. Whole words are compared, so "today" does not match "someday".
const FUZZY_MAX_EDIT_RATIO = 0.25;

// Fuzzy match quality doubles as relevance: the whole query appears verbatim,
// every query word appears verbatim, or some word only matched fuzzily.
const PHRASE_MATCH: Relevance = 1;
const ALL_TOKENS_MATCH: Relevance = 2;
const FUZZY_TOKEN_MATCH: Relevance = 3;

export async function handleSearchVault(
  vault: VaultManager,
  args: {
    query: string;
    exact?: boolean;
    path_filter?: string;
    file_types?: string[];
    limit?: number;
    context_lines?: number;
  },
): Promise<ToolResponse> {
  try {
    const isExact = args.exact || false;
    const limit = args.limit || DEFAULT_SEARCH_LIMIT;
    const fileTypes = args.file_types || ['md'];
    const contextLines = clamp(args.context_lines ?? 0, 0, MAX_CONTEXT_LINES);

    // List all files
    const allFiles = await vault.listFiles('', {
      fileTypes,
      recursive: true,
    });

    // Apply path filter if provided
    let filesToSearch = allFiles;
    if (args.path_filter) {
      const pathRegex = new RegExp(args.path_filter, 'i');
      filesToSearch = allFiles.filter(f => pathRegex.test(f));
    }

    const matcher = isExact ? exactMatcher(args.query) : fuzzyMatcher(args.query);
    const found = await searchFiles(vault, filesToSearch, matcher, isExact, contextLines);
    const results = rankResults(found).slice(0, limit);

    return {
      success: true,
      data: {
        results,
        total_matches: found.length,
        total_files: results.length,
      },
      metadata: { timestamp: new Date().toISOString() },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      metadata: { timestamp: new Date().toISOString() },
    };
  }
}

async function searchFiles(
  vault: VaultManager,
  files: string[],
  matcher: Matcher,
  isExact: boolean,
  contextLines: number,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  for (const path of files) {
    const relevance = matcher(path.split('/').pop() || path);
    if (relevance !== null) {
      results.push({
        path,
        match_type: 'filename',
        relevance_score: isExact ? 1 : relevance, // exact filename hits always score 1
      });
    }
  }

  // Every file is read before ranking, so the best matches win rather than
  // whichever files happen to come first.
  for (let i = 0; i < files.length; i += READ_BATCH_SIZE) {
    const batch = files.slice(i, i + READ_BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async path => {
        try {
          const lines = (await vault.readFile(path)).split('\n');
          return contentResult(path, lines, matcher, contextLines);
        } catch (error) {
          logger.warn(`Error reading file during search`, { path, error });
          return null;
        }
      }),
    );

    for (const result of batchResults) {
      if (result) results.push(result);
    }
  }

  return results;
}

function contentResult(
  path: string,
  lines: string[],
  matcher: Matcher,
  contextLines: number,
): SearchResult | null {
  const hits: Array<{ index: number; relevance: Relevance }> = [];
  lines.forEach((line, index) => {
    const relevance = matcher(line);
    if (relevance !== null) hits.push({ index, relevance });
  });

  if (hits.length === 0) return null;

  // Show the strongest lines (earliest first among equals), in file order.
  const shown = [...hits]
    .sort((a, b) => a.relevance - b.relevance || a.index - b.index)
    .slice(0, MAX_LINES_PER_FILE)
    .sort((a, b) => a.index - b.index);

  return {
    path,
    match_type: 'content',
    relevance_score: Math.min(...hits.map(h => h.relevance)) as Relevance,
    matches: shown.map(({ index }) => ({
      line: index + 1, // 1-based line numbers
      content: truncateLine(lines[index]),
      context_before: lines.slice(Math.max(0, index - contextLines), index).map(truncateLine),
      context_after: lines.slice(index + 1, index + 1 + contextLines).map(truncateLine),
    })),
  };
}

/** Best first; a filename hit outranks a content hit with the same score. */
function rankResults(results: SearchResult[]): SearchResult[] {
  const typeOrder = (r: SearchResult) => (r.match_type === 'filename' ? 0 : 1);
  // Array.prototype.sort is stable, so ties keep vault order.
  return [...results].sort(
    (a, b) => a.relevance_score - b.relevance_score || typeOrder(a) - typeOrder(b),
  );
}

function exactMatcher(query: string): Matcher {
  const queryLower = query.toLowerCase();
  const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(queryLower)}\\b`, 'i');

  return text => {
    const textLower = text.toLowerCase();
    if (!textLower.includes(queryLower)) return null;
    if (textLower.trim().startsWith(queryLower) || wordBoundaryRegex.test(text)) return 1;
    return 2;
  };
}

/**
 * Every query word must match a word in the text, in any order: verbatim as a
 * substring, or failing that by a small edit distance against a whole word.
 */
function fuzzyMatcher(query: string): Matcher {
  const queryLower = query.toLowerCase().trim();
  const tokens = queryLower.split(/\s+/).filter(t => t.length > 0);
  // Notes repeat the same words constantly, so remember each verdict.
  const verdicts = new Map<string, boolean>();

  const fuzzyMatchesWord = (token: string, word: string): boolean => {
    const key = `${token}\u0000${word}`;
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      verdict = isWithinEditRatio(token, word);
      verdicts.set(key, verdict);
    }
    return verdict;
  };

  return text => {
    if (tokens.length === 0) return null;
    const textLower = text.toLowerCase();
    if (textLower.includes(queryLower)) return PHRASE_MATCH;

    let words: string[] | null = null;
    let usedFuzzy = false;
    for (const token of tokens) {
      if (textLower.includes(token)) continue;
      words ??= textLower.match(/\w+/g) || [];
      if (!words.some(word => fuzzyMatchesWord(token, word))) return null;
      usedFuzzy = true;
    }
    return usedFuzzy ? FUZZY_TOKEN_MATCH : ALL_TOKENS_MATCH;
  };
}

function isWithinEditRatio(a: string, b: string): boolean {
  const longest = Math.max(a.length, b.length);
  // Strictly under the ratio, so short words never match fuzzily.
  const maxEdits = Math.ceil(longest * FUZZY_MAX_EDIT_RATIO) - 1;
  if (maxEdits < 1 || Math.abs(a.length - b.length) > maxEdits) return false;
  return editDistance(a, b) <= maxEdits;
}

/** Levenshtein distance, keeping two rows. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + TRUNCATION_MARKER : line;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
