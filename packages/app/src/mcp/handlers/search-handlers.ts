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

/** Rates how well a line or filename matches an exact query; null means no match. */
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

// How many of the query's words a note must contain. Queries of one or two
// words are deliberate, so every word must be there — dropping one would turn
// a two-word query into a much broader one-word search. Longer queries are
// usually natural language padded with words the note may not use ("Grace
// site changes today"), so half the words are enough to match and ranking
// puts notes with fuller coverage first.
const ALL_WORDS_REQUIRED_UP_TO = 2;
const MIN_COVERAGE_RATIO = 0.5;

// Too common to say anything about a note. Dropped from coverage unless the
// query is nothing but these, in which case they are all there is to match.
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'and',
  'or',
  'for',
  'is',
  'are',
  'what',
  'how',
  'about',
  'with',
]);

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

    const found = isExact
      ? await exactSearch(vault, filesToSearch, args.query, contextLines)
      : await fuzzySearch(vault, filesToSearch, args.query, contextLines);
    const results = found.slice(0, limit);

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

/**
 * Read every file (in batches) and collect what `evaluate` makes of each.
 * Every file is read before ranking, so the best matches win rather than
 * whichever files happen to come first.
 */
async function evaluateFiles<T>(
  vault: VaultManager,
  files: string[],
  evaluate: (path: string, content: string) => T | null,
): Promise<T[]> {
  const results: T[] = [];

  for (let i = 0; i < files.length; i += READ_BATCH_SIZE) {
    const batch = files.slice(i, i + READ_BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async path => {
        try {
          return evaluate(path, await vault.readFile(path));
        } catch (error) {
          logger.warn(`Error reading file during search`, { path, error });
          return null;
        }
      }),
    );

    for (const result of batchResults) {
      if (result !== null) results.push(result);
    }
  }

  return results;
}

function filenameOf(path: string): string {
  return path.split('/').pop() || path;
}

function toLineMatch(lines: string[], index: number, contextLines: number): LineMatch {
  return {
    line: index + 1, // 1-based line numbers
    content: truncateLine(lines[index]),
    context_before: lines.slice(Math.max(0, index - contextLines), index).map(truncateLine),
    context_after: lines.slice(index + 1, index + 1 + contextLines).map(truncateLine),
  };
}

// ---------------------------------------------------------------------------
// Exact mode: the query is one literal substring, matched line by line.
// ---------------------------------------------------------------------------

async function exactSearch(
  vault: VaultManager,
  files: string[],
  query: string,
  contextLines: number,
): Promise<SearchResult[]> {
  const matcher = exactMatcher(query);
  const results: SearchResult[] = [];

  for (const path of files) {
    if (matcher(filenameOf(path)) !== null) {
      results.push({ path, match_type: 'filename', relevance_score: 1 });
    }
  }

  results.push(
    ...(await evaluateFiles(vault, files, (path, content) =>
      exactContentResult(path, content.split('\n'), matcher, contextLines),
    )),
  );

  return rankExactResults(results);
}

function exactContentResult(
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
    matches: shown.map(({ index }) => toLineMatch(lines, index, contextLines)),
  };
}

/** Best first; a filename hit outranks a content hit with the same score. */
function rankExactResults(results: SearchResult[]): SearchResult[] {
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

// ---------------------------------------------------------------------------
// Fuzzy mode: a note is scored as a whole (filename + content) by how many of
// the query's words it contains, wherever they appear.
// ---------------------------------------------------------------------------

interface ParsedQuery {
  /** The whole query, lowercased and whitespace-normalised. */
  phrase: string;
  /** Distinct words that count toward coverage. */
  words: string[];
  /** How many of `words` a note must contain to match. */
  required: number;
}

type WordHit = 'verbatim' | 'fuzzy' | null;

interface RankedResult {
  result: SearchResult;
  isPhrase: boolean;
  matched: number;
  fuzzy: number;
}

function parseQuery(query: string): ParsedQuery {
  const phrase = query.toLowerCase().trim().split(/\s+/).join(' ');
  const all = Array.from(new Set(phrase.split(' ').filter(w => w.length > 0)));
  const meaningful = all.filter(w => !STOP_WORDS.has(w));
  const words = meaningful.length > 0 ? meaningful : all;
  const required =
    words.length <= ALL_WORDS_REQUIRED_UP_TO
      ? words.length
      : Math.ceil(words.length * MIN_COVERAGE_RATIO);
  return { phrase, words, required };
}

async function fuzzySearch(
  vault: VaultManager,
  files: string[],
  query: string,
  contextLines: number,
): Promise<SearchResult[]> {
  const parsed = parseQuery(query);
  if (parsed.words.length === 0) return [];

  const findWord = wordFinder();
  const ranked = await evaluateFiles(vault, files, (path, content) =>
    fuzzyFileResult(path, content, parsed, findWord, contextLines),
  );

  // Phrase first, then more query words, then fewer fuzzy-only words, then
  // filename over content. Sort is stable, so ties keep vault order.
  const typeOrder = (r: RankedResult) => (r.result.match_type === 'filename' ? 0 : 1);
  return ranked
    .sort(
      (a, b) =>
        Number(b.isPhrase) - Number(a.isPhrase) ||
        b.matched - a.matched ||
        a.fuzzy - b.fuzzy ||
        typeOrder(a) - typeOrder(b),
    )
    .map(r => r.result);
}

function fuzzyFileResult(
  path: string,
  content: string,
  query: ParsedQuery,
  findWord: WordFinder,
  contextLines: number,
): RankedResult | null {
  const filenameLower = filenameOf(path).toLowerCase();
  const contentLower = content.toLowerCase();
  const isPhrase = filenameLower.includes(query.phrase) || contentLower.includes(query.phrase);

  const filenameHits = query.words.map(word => findWord(word, filenameLower));
  const contentHits = query.words.map(word => findWord(word, contentLower));
  const hits = query.words.map((_, i) => strongerHit(filenameHits[i], contentHits[i]));

  const matched = hits.filter(h => h !== null).length;
  if (!isPhrase && matched < query.required) return null;

  const fuzzy = hits.filter(h => h === 'fuzzy').length;
  const filenameMatched = filenameHits.filter(h => h !== null).length;
  const isFilenameMatch = filenameLower.includes(query.phrase) || filenameMatched >= query.required;

  // Only words found somewhere in the content can pick out lines.
  const lineWords = query.words.filter((_, i) => contentHits[i] !== null);
  const lines = content.split('\n');
  const matches = bestLines(lines, lineWords, query.phrase, findWord).map(index =>
    toLineMatch(lines, index, contextLines),
  );

  return {
    result: {
      path,
      match_type: isFilenameMatch ? 'filename' : 'content',
      relevance_score: fuzzyRelevance(isPhrase, matched, fuzzy, query.words.length),
      ...(matches.length > 0 ? { matches } : {}),
    },
    isPhrase,
    matched,
    fuzzy,
  };
}

/**
 * Public relevance stays 1-4, lower is better:
 * 1 = whole phrase, or every word verbatim; 2 = every word, some only fuzzily;
 * 3 = enough words, all verbatim; 4 = enough words, some only fuzzily.
 */
function fuzzyRelevance(
  isPhrase: boolean,
  matched: number,
  fuzzy: number,
  total: number,
): Relevance {
  if (isPhrase || (matched === total && fuzzy === 0)) return 1;
  if (matched === total) return 2;
  return fuzzy === 0 ? 3 : 4;
}

/** Indexes of the lines with the most query words (phrase lines first), in file order. */
function bestLines(
  lines: string[],
  words: string[],
  phrase: string,
  findWord: WordFinder,
): number[] {
  if (words.length === 0) return [];

  const scored: Array<{ index: number; isPhrase: boolean; count: number }> = [];
  lines.forEach((line, index) => {
    const lineLower = line.toLowerCase();
    const count = words.filter(word => findWord(word, lineLower) !== null).length;
    if (count > 0) scored.push({ index, isPhrase: lineLower.includes(phrase), count });
  });

  return scored
    .sort(
      (a, b) => Number(b.isPhrase) - Number(a.isPhrase) || b.count - a.count || a.index - b.index,
    )
    .slice(0, MAX_LINES_PER_FILE)
    .map(s => s.index)
    .sort((a, b) => a - b);
}

function strongerHit(a: WordHit, b: WordHit): WordHit {
  if (a === 'verbatim' || b === 'verbatim') return 'verbatim';
  return a ?? b;
}

/** Finds a query word in lowercased text: verbatim substring, else a fuzzy whole word. */
type WordFinder = (word: string, textLower: string) => WordHit;

function wordFinder(): WordFinder {
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

  return (word, textLower) => {
    if (textLower.includes(word)) return 'verbatim';
    const textWords = textLower.match(/\w+/g) || [];
    return textWords.some(w => fuzzyMatchesWord(word, w)) ? 'fuzzy' : null;
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
