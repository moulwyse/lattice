import { readFileSync } from 'node:fs';
import { extname, posix } from 'node:path';
import { rawHash, safeReadPath } from './core.js';
import type { ContextPage, FileRecord, RepositoryIndex, TaskIR } from './types.js';

export const MAX_WHOLE_FILE_CONTEXT_CHARACTERS = 12_000;
/** High-risk tasks prefer whole files, up to a size that still fits the budget. */
export const MAX_HIGH_RISK_WHOLE_FILE_CONTEXT_CHARACTERS = 32_000;
export const TARGET_CONTEXT_SLICE_CHARACTERS = 6_000;
const JAVASCRIPT_RUNTIME_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];

const stopWords = new Set([
  'and',
  'behavior',
  'change',
  'file',
  'fix',
  'for',
  'from',
  'into',
  'not',
  'preserve',
  'return',
  'that',
  'the',
  'this',
  'with',
]);

function contextTerms(task: TaskIR, focus?: string) {
  return [
    focus ?? '',
    task.goal,
    ...task.acceptanceCriteria.map((criterion) => criterion.text),
  ]
    .join(' ')
    .toLowerCase()
    .match(/[a-z_$][a-z0-9_$-]{2,}/g)
    ?.filter((term, index, all) => !stopWords.has(term) && all.indexOf(term) === index) ?? [];
}

function exactContextSlice(content: string, task: TaskIR, focus?: string) {
  const lines = content.split(/(?<=\n)/);
  const terms = contextTerms(task, focus);
  let bestLine = 0;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].toLowerCase();
    const score = terms.reduce(
      (total, term) => total + (line.includes(term) ? (term === focus?.toLowerCase() ? 8 : 1) : 0),
      0,
    );
    if (score > bestScore) {
      bestLine = index;
      bestScore = score;
    }
  }

  let start = bestLine;
  let end = bestLine + 1;
  let characters = lines[bestLine]?.length ?? 0;
  while (characters < TARGET_CONTEXT_SLICE_CHARACTERS && (start > 0 || end < lines.length)) {
    const before = start > 0 ? lines[start - 1].length : Number.POSITIVE_INFINITY;
    const after = end < lines.length ? lines[end].length : Number.POSITIVE_INFINITY;
    if (before <= after) {
      start -= 1;
      characters += lines[start].length;
    } else {
      characters += lines[end].length;
      end += 1;
    }
  }
  return {
    content: lines.slice(start, end).join(''),
    startLine: start + 1,
    endLine: end,
  };
}

function createPage(
  workspace: string,
  file: FileRecord,
  reason: string,
  task: TaskIR,
  options: { forceFull?: boolean; forceSlice?: boolean; focus?: string } = {},
): ContextPage {
  const bytes = readFileSync(safeReadPath(workspace, file.path));
  if (
    bytes.length !== file.fingerprint.byteLength ||
    rawHash(bytes) !== file.fingerprint.rawSha256
  ) {
    throw new Error(`repository source changed since indexing: ${file.path}; rebuild the index`);
  }
  const content = bytes.toString('utf8');
  const wholeFileLimit =
    task.risk === 'high'
      ? MAX_HIGH_RISK_WHOLE_FILE_CONTEXT_CHARACTERS
      : MAX_WHOLE_FILE_CONTEXT_CHARACTERS;
  const complete =
    !options.forceSlice && (options.forceFull || content.length <= wholeFileLimit);
  const selected = complete
    ? {
        content,
        startLine: 1,
        endLine: Math.max(1, content.split(/\r?\n/).length - (/\n$/.test(content) ? 1 : 0)),
      }
    : exactContextSlice(content, task, options.focus);
  return {
    id: complete
      ? `file:${file.path}:${file.fingerprint.value}`
      : `file:${file.path}:${file.fingerprint.value}:L${selected.startLine}-L${selected.endLine}`,
    kind: file.isTest ? 'test' : file.isConfig ? 'config' : complete ? 'file' : 'symbol',
    path: file.path,
    fingerprint: file.fingerprint,
    startLine: selected.startLine,
    endLine: selected.endLine,
    content: selected.content,
    reason,
    provenance: 'fresh-index',
    estimatedTokens: Math.ceil(selected.content.length / 4),
    invalidated: false,
    complete,
  };
}

const relevanceStopWords = new Set([
  ...stopWords,
  'add', 'all', 'are', 'but', 'can', 'code', 'does', 'each', 'has', 'have', 'its',
  'make', 'must', 'new', 'now', 'only', 'should', 'some', 'test', 'tests', 'them',
  'then', 'use', 'using', 'when', 'will', 'work',
]);

function relevanceTerms(task: TaskIR) {
  // Criteria are derived from the goal, so the goal alone carries every term;
  // counting each distinct term once keeps repeated words from dominating.
  const words =
    task.goal
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]+/g) ?? [];
  return [...new Set(words)].filter(
    (term) => term.length >= 3 && !relevanceStopWords.has(term),
  );
}

function relevance(file: FileRecord, task: TaskIR) {
  const terms = relevanceTerms(task);
  const path = file.path.toLowerCase();
  return terms.reduce(
    (score, term) =>
      score +
      (path.includes(term) ? 8 : 0) +
      (file.symbols.some((symbol) => symbol.toLowerCase().includes(term)) ? 5 : 0) +
      (file.references.some((reference) => reference.toLowerCase().includes(term)) ? 2 : 0),
    file.isTest ? 2 : 0,
  );
}

export const MAX_REPOSITORY_MAP_CHARACTERS = 12_000;
const MAX_MAP_SYMBOLS_PER_FILE = 8;

/**
 * The map of ungranted files shown to the worker. It is ranked by task
 * relevance and capped, so the prompt no longer grows with repository size;
 * the worker can still fault in any file by path.
 */
export function repositoryMapForTask(
  index: RepositoryIndex,
  task: TaskIR,
  grantedPaths: ReadonlySet<string>,
  maxCharacters = MAX_REPOSITORY_MAP_CHARACTERS,
) {
  const ranked = index.files
    .filter((file) => !grantedPaths.has(file.path))
    .map((file) => ({ file, score: relevance(file, task) }))
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const map: { path: string; symbols: string[] }[] = [];
  let characters = 2;
  for (const { file } of ranked) {
    const symbols = [...new Set(file.symbols)].slice(0, MAX_MAP_SYMBOLS_PER_FILE);
    const size = JSON.stringify([file.path, symbols]).length + 1;
    if (characters + size > maxCharacters) break;
    map.push({ path: file.path, symbols });
    characters += size;
  }
  return map;
}

function localImportCandidates(importerPath: string, specifier: string) {
  if (!specifier.startsWith('.')) return [];
  const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  const extension = extname(base);
  if (extension) {
    // TypeScript ESM imports name the emitted `.js` file; resolve the source.
    const stem = base.slice(0, -extension.length);
    const sources: Record<string, string[]> = {
      '.js': ['.ts', '.tsx'],
      '.jsx': ['.tsx'],
      '.mjs': ['.mts'],
      '.cjs': ['.cts'],
    };
    return [base, ...(sources[extension] ?? []).map((source) => `${stem}${source}`)];
  }
  return [
    `${base}.js`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.mts`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
}

export function resolveLocalImport(
  index: RepositoryIndex,
  importerPath: string,
  specifier: string,
) {
  for (const candidate of localImportCandidates(importerPath, specifier)) {
    const exact = index.files.find((file) => file.path === candidate);
    if (exact) return exact;
  }
  return undefined;
}

function mirrorKey(path: string) {
  return path.replace(/\.(?:[mc]?tsx?|[mc]?jsx?)$/, '');
}

function semanticStem(path: string) {
  return posix.basename(mirrorKey(path)).toLowerCase();
}

export function initialContextFiles(index: RepositoryIndex, task: TaskIR) {
  const nodeJavaScriptTests = Object.values(index.scripts).some((script) =>
    /\bnode\s+--test\b/.test(script),
  );
  const tests = index.files
    .filter(
      (file) =>
        file.isTest &&
        (!nodeJavaScriptTests || JAVASCRIPT_RUNTIME_EXTENSIONS.includes(extname(file.path))),
    )
    .map((file) => ({ file, score: relevance(file, task) }))
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const relevantTests = tests.some((candidate) => candidate.score > 2)
    ? tests.filter((candidate) => candidate.score > 2)
    : tests;

  const selected: { file: FileRecord; reason: string }[] = [];
  const selectedPaths = new Set<string>();
  const runtimeMirrorKeys = new Set<string>();
  const runtimeStems = new Set<string>();
  const add = (file: FileRecord | undefined, reason: string) => {
    if (!file || selectedPaths.has(file.path)) return;
    selectedPaths.add(file.path);
    selected.push({ file, reason });
    if (JAVASCRIPT_RUNTIME_EXTENSIONS.includes(extname(file.path))) {
      runtimeMirrorKeys.add(mirrorKey(file.path));
      runtimeStems.add(semanticStem(file.path));
    }
  };

  for (const candidate of relevantTests) {
    add(candidate.file, 'initial:test acceptance/runtime');
  }

  const directRuntimeFiles: FileRecord[] = [];
  for (const candidate of relevantTests) {
    for (const specifier of candidate.file.imports) {
      const dependency = resolveLocalImport(index, candidate.file.path, specifier);
      if (!dependency) continue;
      add(dependency, `initial:direct runtime dependency of ${candidate.file.path}`);
      directRuntimeFiles.push(dependency);
    }
  }

  for (const runtimeFile of directRuntimeFiles) {
    for (const specifier of runtimeFile.imports) {
      add(
        resolveLocalImport(index, runtimeFile.path, specifier),
        `initial:one-hop runtime dependency of ${runtimeFile.path}`,
      );
    }
  }

  const relevantRemaining = index.files
    .filter((file) => !selectedPaths.has(file.path))
    .map((file) => ({ file, score: relevance(file, task) }))
    .filter((candidate) => candidate.score > 0)
    .filter((candidate) => {
      const extension = extname(candidate.file.path);
      if (
        ['.ts', '.tsx'].includes(extension) &&
        runtimeMirrorKeys.has(mirrorKey(candidate.file.path))
      ) {
        return false;
      }
      return !runtimeStems.has(semanticStem(candidate.file.path));
    })
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  for (const candidate of relevantRemaining) {
    add(candidate.file, 'initial:task/criterion relevance');
  }

  return selected;
}

export class ContextKernel {
  pages: ContextPage[] = [];
  faults: { reason: string; target: string; loaded: string[] }[] = [];

  constructor(
    readonly workspace: string,
    readonly index: RepositoryIndex,
    readonly task: TaskIR,
  ) {}

  initial() {
    for (const candidate of initialContextFiles(this.index, this.task)) {
      // Initial pages never evict other initial pages. Once the page budget is
      // full, reading further candidates cannot change the selected context.
      if (this.pages.length >= this.task.budget.maxPages) break;
      this.add(createPage(this.workspace, candidate.file, candidate.reason, this.task));
    }
    return this.pages;
  }

  add(candidate: ContextPage) {
    if (this.pages.some((page) => page.id === candidate.id)) return;
    if (candidate.complete !== false) {
      this.pages = this.pages.filter(
        (page) => page.path !== candidate.path || page.complete !== false,
      );
    }
    this.pages.push(candidate);
    while (
      this.pages.length > this.task.budget.maxPages ||
      this.pages.reduce((total, page) => total + page.estimatedTokens, 0) >
        this.task.budget.maxTokens
    ) {
      if (candidate.reason.startsWith('initial:')) {
        this.pages.splice(this.pages.indexOf(candidate), 1);
        break;
      }
      const evict = this.pages
        .map((page, index) => ({ page, index }))
        .reverse()
        .find(({ page }) => page !== candidate && page.reason.startsWith('initial:'));
      if (!evict) {
        this.pages.splice(this.pages.indexOf(candidate), 1);
        break;
      }
      this.pages.splice(evict.index, 1);
    }
  }

  resolve(request: { reason: string; pathHint?: string; symbol?: string }) {
    const hint = request.pathHint?.replaceAll('\\', '/');
    const base = hint?.replace(/\.(ts|tsx|js|jsx)$/, '');
    const candidates = hint
      ? [
          hint,
          ...['.ts', '.tsx', '.js', '.jsx'].map((extension) => base + extension),
          `${base}/index.ts`,
          `${base}/index.js`,
        ]
      : [];
    const file =
      candidates
        .map((path) => this.index.files.find((candidate) => candidate.path === path))
        .find(Boolean) ??
      this.index.files.find(
        (candidate) => request.symbol && candidate.symbols.includes(request.symbol),
      );
    if (!file) throw new Error(`context request cannot be resolved: ${hint ?? request.symbol}`);
    const existingSlice = this.pages.some(
      (page) => page.path === file.path && page.complete === false,
    );
    let loaded = createPage(this.workspace, file, request.reason, this.task, {
      forceFull: existingSlice && Boolean(hint),
      focus: request.symbol,
    });
    this.add(loaded);
    if (!this.pages.some((page) => page.id === loaded.id) && loaded.complete !== false) {
      // A whole file that cannot fit the budget falls back to the slice
      // around the requested symbol instead of failing the task.
      loaded = createPage(this.workspace, file, request.reason, this.task, {
        forceSlice: true,
        focus: request.symbol,
      });
      this.add(loaded);
    }
    if (!this.pages.some((page) => page.id === loaded.id)) {
      throw new Error(`context page exceeds configured budget: ${loaded.path}`);
    }
    this.faults.push({
      reason: request.reason,
      target: hint ?? request.symbol!,
      loaded: [loaded.id],
    });
    return loaded;
  }
}
