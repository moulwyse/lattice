import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { execa } from 'execa';
import { readFingerprintedFile } from './fingerprint.js';
import { metadata, safeReadPath, writeJson } from './core.js';
import type { FileRecord, RepositoryIndex } from './types.js';

const ignored = new Set([
  '.git',
  '.lattice',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'generated',
]);
const supported = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md']);

function walk(root: string, base = root): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const full = join(root, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    if (!supported.has(extname(entry.name))) return [];
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
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => supported.has(extname(path)))
    .filter((path) => !path.split('/').some((part) => ignored.has(part)))
    .sort();
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
  const readRecord = async (path: string): Promise<FileRecord | undefined> => {
    try {
      safeReadPath(workspace, path);
    } catch {
      // Tracked symlinks/junctions may never expose content outside the
      // repository through the index or MCP context bridge.
      return undefined;
    }
    const { bytes, fingerprint: sourceFingerprint } = await readFingerprintedFile(workspace, path);
    if (bytes.includes(0)) return undefined;
    const text = bytes.toString('utf8');
    const extension = extname(path);
    const imports = [...text.matchAll(/(?:from\s+|require\()['"]([^'"]+)/g)].map(
      (match) => match[1],
    );
    const exports = [
      ...text.matchAll(/export\s+(?:class|function|const|type|interface)\s+(\w+)/g),
    ].map((match) => match[1]);
    const symbols = [
      ...text.matchAll(/(?:class|function|const|interface|type)\s+(\w+)/g),
    ].map((match) => match[1]);
    const references = [
      ...new Set([
        ...imports,
        ...[...text.matchAll(/\b(?:new|extends|implements)\s+(\w+)/g)].map(
          (match) => match[1],
        ),
      ]),
    ];
    return {
      path,
      language:
        {
          '.ts': 'typescript',
          '.tsx': 'typescript',
          '.js': 'javascript',
          '.jsx': 'javascript',
          '.json': 'json',
          '.md': 'markdown',
        }[extension] ?? 'text',
      size: bytes.length,
      fingerprint: sourceFingerprint,
      imports,
      exports,
      symbols,
      references,
      isTest: /(\.test\.|\.spec\.|\/tests?\/)/.test(path),
      isConfig: /package\.json|tsconfig|config/.test(path),
    };
  };
  // Bound both concurrent file buffers and Git subprocess work. Await every
  // operation in a batch before throwing, and preserve the sorted path order.
  // No partial index is persisted if any file fails its read/fingerprint.
  const batchSize = 4;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    const records = await Promise.allSettled(
      paths.slice(offset, offset + batchSize).map(readRecord),
    );
    for (const record of records) {
      if (record.status === 'rejected') throw record.reason;
      if (record.value) files.push(record.value);
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
