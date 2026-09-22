import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { execa } from 'execa';
import { readFingerprintedFile } from './fingerprint.js';
import { metadata, rawHash, safeReadPath, writeJson } from './core.js';
import type { FileRecord, Fingerprint, RepositoryIndex } from './types.js';

/** Directory names that are never indexed (and never watched). */
export const INDEX_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.lattice',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'generated',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
]);

const languages: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
};

/** Files larger than this are listed nowhere: they are data, not source. */
const MAX_INDEXED_FILE_BYTES = 1_000_000;

const javascriptLike = new Set(['typescript', 'javascript', 'vue', 'svelte']);

const symbolPatterns: Record<string, RegExp[]> = {
  javascript: [
    /\b(?:class|function\*?|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
  ],
  python: [/^\s*(?:async\s+)?(?:def|class)\s+(\w+)/gm, /^([A-Za-z_]\w*)\s*=/gm],
  go: [/\bfunc\s+(?:\([^)]*\)\s*)?(\w+)/g, /\btype\s+(\w+)/g],
  rust: [/\b(?:fn|struct|enum|trait|mod|type|const|static)\s+(\w+)/g],
  java: [
    /\b(?:class|interface|enum|record)\s+(\w+)/g,
    /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized)\s+){1,4}[\w<>[\],.]+\s+(\w+)\s*\(/gm,
  ],
  kotlin: [/\b(?:class|interface|object|fun|val|var)\s+(\w+)/g],
  csharp: [/\b(?:class|interface|enum|struct|record)\s+(\w+)/g],
  ruby: [/^\s*(?:def|class|module)\s+(?:self\.)?(\w+)/gm],
  php: [/\b(?:function|class|interface|trait)\s+(\w+)/g],
  swift: [/\b(?:func|class|struct|enum|protocol)\s+(\w+)/g],
  c: [/^(?:[\w*]+[ \t]+){1,4}\**(\w+)\s*\([^;{}\n]*\)\s*\{?\s*$/gm, /\b(?:struct|enum|typedef)\s+(\w+)/g],
  cpp: [
    /^(?:[\w:*&<>]+[ \t]+){1,4}\**([\w:~]+)\s*\([^;{}\n]*\)\s*(?:const\s*)?\{?\s*$/gm,
    /\b(?:class|struct|enum|namespace)\s+(\w+)/g,
  ],
};
symbolPatterns.typescript = symbolPatterns.javascript;
symbolPatterns.vue = symbolPatterns.javascript;
symbolPatterns.svelte = symbolPatterns.javascript;

const importPatterns: Record<string, RegExp[]> = {
  javascript: [
    /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm,
  ],
  python: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  go: [/^\s*(?:import\s+)?(?:\w+\s+)?"([\w./-]+)"\s*$/gm],
  rust: [/^\s*use\s+([\w:]+)/gm, /^\s*mod\s+(\w+)\s*;/gm],
  java: [/^\s*import\s+(?:static\s+)?([\w.]+)/gm],
  kotlin: [/^\s*import\s+([\w.]+)/gm],
  csharp: [/^\s*using\s+([\w.]+)\s*;/gm],
  ruby: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
  php: [/^\s*use\s+([\w\\]+)/gm, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g],
  c: [/^\s*#include\s+["<]([^">]+)[">]/gm],
  cpp: [/^\s*#include\s+["<]([^">]+)[">]/gm],
};
importPatterns.typescript = importPatterns.javascript;
importPatterns.vue = importPatterns.javascript;
importPatterns.svelte = importPatterns.javascript;

function matches(text: string, patterns: RegExp[] | undefined) {
  if (!patterns) return [];
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match.slice(1).find(Boolean)!).filter(Boolean),
  );
}

const slashCommentLanguages = new Set(['go', 'rust', 'java', 'kotlin', 'csharp', 'swift', 'c', 'cpp', 'php']);
const hashCommentLanguages = new Set(['python', 'ruby', 'shell', 'yaml', 'toml']);

/**
 * Blank out comments that start a line (doc blocks, line comments) so prose
 * never contributes symbols or imports. Comments after code are left alone:
 * without a tokenizer, `//` and `/*` inside strings cannot be told apart.
 */
function stripComments(text: string, language: string) {
  if (javascriptLike.has(language) || slashCommentLanguages.has(language)) {
    return text
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/^[ \t]*\/\/[^\n]*/gm, '');
  }
  if (hashCommentLanguages.has(language)) return text.replace(/^[ \t]*#[^\n]*/gm, '');
  return text;
}

export function isTestPath(path: string) {
  const name = basename(path);
  return (
    /(?:^|\/)(?:tests?|__tests__|spec|specs)\//.test(path) ||
    /\.(?:test|spec)\.[^.]+$/.test(name) ||
    /^test_.+\.py$|_test\.(?:py|go)$|Tests?\.(?:java|kt|cs)$/.test(name)
  );
}

export function isConfigPath(path: string) {
  const name = basename(path).toLowerCase();
  return (
    /^(?:package|composer|tsconfig(?:\.[\w-]+)?|jsconfig|deno|bunfig)\.json$/.test(name) ||
    /\.config\.[cm]?[jt]s$/.test(name) ||
    /^\.[\w-]+rc(?:\.(?:json|js|cjs|yaml|yml))?$/.test(name) ||
    /^(?:pyproject\.toml|setup\.cfg|cargo\.toml|go\.mod|pom\.xml|gemfile)$/.test(name)
  );
}

function walk(root: string, base = root): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (INDEX_IGNORED_DIRECTORIES.has(entry.name)) return [];
    const full = join(root, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    if (!(extname(entry.name) in languages)) return [];
    return [relative(base, full).replaceAll('\\', '/')];
  });
}

async function repositoryPaths(workspace: string, git: boolean) {
  if (!git) return walk(workspace).sort();
  const result = await execa(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: workspace },
  );
  return [
    ...new Set(
      result.stdout
        .split('\0')
        .filter(Boolean)
        .map((path) => path.replaceAll('\\', '/'))
        .filter((path) => extname(path) in languages)
        .filter((path) => !path.split('/').some((part) => INDEX_IGNORED_DIRECTORIES.has(part))),
    ),
  ].sort();
}

/** Index object ids of regular tracked files, from one `git ls-files --stage`. */
async function trackedObjectIds(workspace: string) {
  const result = await execa('git', ['ls-files', '--stage', '-z'], { cwd: workspace });
  const counts = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const entry of result.stdout.split('\0')) {
    const match = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t(.+)$/s);
    if (!match) continue;
    const path = match[4];
    counts.set(path, (counts.get(path) ?? 0) + 1);
    // Symlinks and conflicted (multi-stage) entries take the exact per-file path.
    if (match[1] !== '120000' && match[3] === '0') ids.set(path, match[2]);
  }
  for (const [path, count] of counts) if (count !== 1) ids.delete(path);
  return ids;
}

/** Working-tree object ids through Git's own filters, one process per batch. */
async function workingObjectIds(workspace: string, paths: string[]) {
  if (paths.length === 0) return [];
  const result = await execa('git', ['hash-object', '--stdin-paths'], {
    cwd: workspace,
    input: `${paths.join('\n')}\n`,
    reject: false,
  });
  const ids = result.exitCode === 0 ? result.stdout.split(/\r?\n/) : [];
  return paths.map((_, index) => ids[index]?.trim() || null);
}

function recordFor(path: string, bytes: Buffer, fingerprint: Fingerprint): FileRecord {
  const language = languages[extname(path)] ?? 'text';
  const text = stripComments(bytes.toString('utf8'), language);
  const imports = [...new Set(matches(text, importPatterns[language]))];
  const symbols = [...new Set(matches(text, symbolPatterns[language]))];
  const exports = javascriptLike.has(language)
    ? [
        ...new Set(
          matches(text, [
            /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function\*?|const|let|var|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
          ]),
        ),
      ]
    : [];
  const references = [
    ...new Set([
      ...imports,
      ...[...text.matchAll(/\b(?:new|extends|implements)\s+(\w+)/g)].map((match) => match[1]),
    ]),
  ];
  return {
    path,
    language,
    size: bytes.length,
    fingerprint,
    imports,
    exports,
    symbols,
    references,
    isTest: isTestPath(path),
    isConfig: isConfigPath(path),
  };
}

export async function buildIndex(workspace: string): Promise<RepositoryIndex> {
  const gitCheck = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: workspace,
    reject: false,
  });
  const git = gitCheck.exitCode === 0;
  const status = git
    ? (
        await execa('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: workspace,
        })
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean)
    : [];
  const branch = git
    ? (await execa('git', ['branch', '--show-current'], { cwd: workspace })).stdout.trim() || null
    : null;
  const files: FileRecord[] = [];

  const paths = await repositoryPaths(workspace, git);
  const tracked = git ? await trackedObjectIds(workspace) : new Map<string, string>();

  const readRecord = async (
    path: string,
    workingObjectId: string | null,
  ): Promise<FileRecord | undefined> => {
    let full: string;
    try {
      full = safeReadPath(workspace, path);
    } catch {
      // Tracked symlinks/junctions may never expose content outside the
      // repository through the index or MCP context bridge.
      return undefined;
    }
    if (lstatSync(full).size > MAX_INDEXED_FILE_BYTES) return undefined;
    const indexObjectId = tracked.get(path);
    let bytes: Buffer;
    let fingerprint: Fingerprint;
    if (indexObjectId && workingObjectId === indexObjectId && !lstatSync(full).isSymbolicLink()) {
      // Clean tracked file: the batch hash already proved the Git identity.
      bytes = readFileSync(full);
      const raw = rawHash(bytes);
      fingerprint = {
        kind: 'git',
        value: `git:${indexObjectId}`,
        rawSha256: raw,
        byteLength: bytes.length,
      };
    } else {
      ({ bytes, fingerprint } = await readFingerprintedFile(workspace, path));
    }
    if (bytes.includes(0)) return undefined;
    return recordFor(path, bytes, fingerprint);
  };

  // Hash tracked candidates in large batches (one Git process each); only
  // dirty, untracked, symlinked or unusual files fall back to per-file probes.
  // Await every operation in a batch before throwing, and preserve the sorted
  // path order. No partial index is persisted if any file fails.
  const batchSize = 256;
  const concurrency = 4;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    const batch = paths.slice(offset, offset + batchSize);
    const hashable = batch.filter((path) => tracked.has(path) && !/[\r\n]/.test(path));
    const hashed = git ? await workingObjectIds(workspace, hashable) : [];
    const workingIds = new Map(hashable.map((path, index) => [path, hashed[index] ?? null]));
    for (let start = 0; start < batch.length; start += concurrency) {
      const records = await Promise.allSettled(
        batch
          .slice(start, start + concurrency)
          .map((path) => readRecord(path, workingIds.get(path) ?? null)),
      );
      for (const record of records) {
        if (record.status === 'rejected') throw record.reason;
        if (record.value) files.push(record.value);
      }
    }
  }

  let scripts: Record<string, string> = {};
  try {
    scripts =
      (JSON.parse(readFileSync(safeReadPath(workspace, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }).scripts ?? {};
  } catch {
    // A package manifest is optional.
  }
  const result: RepositoryIndex = {
    version: 2,
    workspace,
    createdAt: new Date().toISOString(),
    git: { available: git, branch, status },
    files,
    scripts,
  };
  writeJson(join(metadata(workspace), 'index', 'index.json'), result);
  return result;
}

export function searchIndex(index: RepositoryIndex, query: string, limit = 20) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return index.files
    .map((file) => {
      const fields = [
        file.path,
        ...file.symbols,
        ...file.imports,
        ...file.exports,
        ...file.references,
      ].map((value) => value.toLowerCase());
      const score = terms.reduce(
        (total, term) => total + fields.reduce((sum, field) => sum + (field.includes(term) ? 1 : 0), 0),
        0,
      );
      return { path: file.path, score };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}
