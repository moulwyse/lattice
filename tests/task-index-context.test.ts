import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContextKernel,
  MAX_WHOLE_FILE_CONTEXT_CHARACTERS,
  initialContextFiles,
  resolveLocalImport,
} from '../src/context.js';
import type { RepositoryIndex } from '../src/types.js';
import { fingerprint } from '../src/fingerprint.js';
import { buildIndex, isConfigPath, isTestPath, searchIndex } from '../src/indexer.js';
import { compileTask, TaskSchema, withRepositoryVerification } from '../src/task.js';
import { repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.cleanup();
});

describe('Task compiler', () => {
  it('derives clause criteria from the goal without task-specific vocabulary', () => {
    const task = compileTask(
      'Fix password reset tokens and preserve login behavior; do not change tests.',
    );
    expect(TaskSchema.parse(task)).toEqual(task);
    expect(task.acceptanceCriteria.map((criterion) => criterion.text)).toEqual([
      'Fix password reset tokens and preserve login behavior',
      'do not change tests',
    ]);
    expect(task.invariants.join(' ')).toContain('preserve login behavior');
    expect(task.risk).toBe('high');
  });

  it('splits sentences, list items and comma clauses into criteria', () => {
    expect(
      compileTask('Add a --verbose flag.\n- print each file\n- keep quiet mode default').acceptanceCriteria.map(
        (criterion) => criterion.text,
      ),
    ).toEqual(['Add a --verbose flag', 'print each file', 'keep quiet mode default']);
    expect(compileTask('Refactor').acceptanceCriteria.map((criterion) => criterion.text)).toEqual([
      'Refactor',
    ]);
  });

  it('allowlists only verification-like package scripts', () => {
    const task = withRepositoryVerification(compileTask('Fix value'), {
      test: 'vitest',
      'test:unit': 'vitest run unit',
      typecheck: 'tsc --noEmit',
      deploy: 'rm -rf /',
      postinstall: 'node x.js',
      'test:watch': 'vitest',
      'test:ui': 'vitest --ui',
      'build:dev': 'vite build --watch',
    });
    expect(task.allowedVerificationCommands).not.toContain('npm run test:watch');
    expect(task.allowedVerificationCommands).not.toContain('npm run test:ui');
    expect(task.allowedVerificationCommands).not.toContain('npm run build:dev');
    expect(task.allowedVerificationCommands).toContain('npm run test:unit');
    expect(task.allowedVerificationCommands).toContain('npm run typecheck');
    expect(task.allowedVerificationCommands).not.toContain('npm run deploy');
    expect(task.allowedVerificationCommands).not.toContain('npm run postinstall');
  });

  it('rejects invalid Task IR budgets', () => {
    const task = compileTask('Make all existing tests pass');
    expect(() =>
      TaskSchema.parse({ ...task, budget: { ...task.budget, maxPages: 0 } }),
    ).toThrow();
  });

  it('classifies only narrow repeatable maintenance as low risk', () => {
    expect(compileTask('Fix a typo in the README').risk).toBe('low');
    expect(compileTask('Rename a public authentication API').risk).toBe('high');
    expect(compileTask('Refactor the repository index').risk).toBe('medium');
  });
});

describe('Terra repository index', () => {
  it('indexes Unicode and literal Git pathspec characters without losing files', async () => {
    const repo = await repository({
      'src/café.js': 'export const cafe = 1;\n',
      'src/[id].js': 'export const bracket = 2;\n',
      'src/i.js': 'export const other = 3;\n',
    });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    expect(index.files.map((file) => file.path)).toEqual([
      'src/[id].js', 'src/café.js', 'src/i.js',
    ]);
    expect(index.files.every((file) => file.fingerprint.kind === 'git')).toBe(true);
  });

  it('is deterministic, ordered, and excludes metadata, ignored, generated, and binary files', async () => {
    const repo = await repository({
      'src/z.js': 'export const z = 1;\n',
      'src/a.js': "import { z } from './z.js';\nexport const a = new Thing();\n",
      'src/binary.js': Buffer.from([0, 1, 2, 3]),
    });
    repositories.push(repo);
    mkdirSync(join(repo.path, 'generated'), { recursive: true });
    writeFileSync(join(repo.path, 'generated', 'output.js'), 'ignored');
    const first = await buildIndex(repo.path);
    const second = await buildIndex(repo.path);
    expect(first.files.map((file) => file.path)).toEqual(['src/a.js', 'src/z.js']);
    expect(second.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path));
    expect(second.files.map((file) => file.fingerprint.value)).toEqual(
      first.files.map((file) => file.fingerprint.value),
    );
    expect(first.files[0].imports).toEqual(['./z.js']);
    expect(first.files[0].references).toContain('Thing');
    expect(searchIndex(first, 'Thing')[0].path).toBe('src/a.js');
  });

  it('indexes non-JavaScript languages and ignores symbols mentioned only in comments', async () => {
    const repo = await repository({
      'app/service.py': '# class NotReal\nfrom app.models import User\n\nclass Service:\n    def run(self):\n        pass\n',
      'cmd/main.go': 'package main\n\nimport "fmt"\n\n// func ghost() {}\nfunc Serve() { fmt.Println() }\n',
      'src/lib.rs': 'use crate::util;\npub struct Engine;\nfn start() {}\n',
      'src/api.ts': '/**\n * function phantom() is documented only\n */\nexport default async function handler() {}\nexport enum Mode { A }\n',
    });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    const byPath = new Map(index.files.map((file) => [file.path, file]));
    expect(byPath.get('app/service.py')).toMatchObject({
      language: 'python',
      imports: ['app.models'],
      symbols: ['Service', 'run'],
    });
    expect(byPath.get('cmd/main.go')?.symbols).toEqual(['Serve']);
    expect(byPath.get('src/lib.rs')?.symbols).toEqual(expect.arrayContaining(['Engine', 'start']));
    expect(byPath.get('src/api.ts')?.symbols).not.toContain('phantom');
    expect(byPath.get('src/api.ts')?.exports).toEqual(['handler', 'Mode']);
    expect(index.files.every((file) => file.fingerprint.kind === 'git')).toBe(true);
  });

  it('matches the per-file fingerprint for clean, dirty, and untracked files', async () => {
    const repo = await repository({
      'src/clean.js': 'export const clean = 1;\n',
      'src/dirty.js': 'export const dirty = 1;\n',
    });
    repositories.push(repo);
    writeFileSync(join(repo.path, 'src/dirty.js'), 'export const dirty = 2;\n');
    writeFileSync(join(repo.path, 'src/new.js'), 'export const fresh = 1;\n');
    const index = await buildIndex(repo.path);
    for (const file of index.files) {
      expect(file.fingerprint).toEqual(await fingerprint(repo.path, file.path));
    }
  });

  it('resolves TypeScript ESM `.js` specifiers to their `.ts` sources', () => {
    const file = (path: string) => ({ path }) as RepositoryIndex['files'][number];
    const index = { files: [file('src/b.ts'), file('src/c.mts')] } as RepositoryIndex;
    expect(resolveLocalImport(index, 'src/a.ts', './b.js')?.path).toBe('src/b.ts');
    expect(resolveLocalImport(index, 'src/a.ts', './c.mjs')?.path).toBe('src/c.mts');
    expect(resolveLocalImport(index, 'src/a.ts', './missing.js')).toBeUndefined();
  });

  it('classifies test and config paths without substring false positives', () => {
    for (const path of ['test/a.js', 'tests/a.js', 'src/__tests__/a.ts', 'a.spec.ts', 'pkg/x_test.go', 'test_x.py']) {
      expect(isTestPath(path), path).toBe(true);
    }
    for (const path of ['src/latest.js', 'src/contest/a.js', 'src/testing.ts']) {
      expect(isTestPath(path), path).toBe(false);
    }
    for (const path of ['package.json', 'tsconfig.build.json', 'vite.config.ts', '.eslintrc.json']) {
      expect(isConfigPath(path), path).toBe(true);
    }
    expect(isConfigPath('src/config-loader.ts')).toBe(false);
  });

  it('excludes tracked and untracked source symlinks whose targets are outside the repository', async (context) => {
    const repo = await repository({
      'src/safe.js': 'export const safe = true;\n',
    });
    const external = await repository({
      'external-secret.js': 'export const outsideSecret = "must-not-be-indexed";\n',
    });
    repositories.push(repo, external);
    const target = join(external.path, 'external-secret.js');
    const trackedPath = join(repo.path, 'src', 'tracked-external.js');
    const untrackedPath = join(repo.path, 'src', 'untracked-external.js');
    try {
      symlinkSync(target, trackedPath, 'file');
      symlinkSync(target, untrackedPath, 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) {
        context.skip(`OS denied test symlink creation (${code})`);
        return;
      }
      throw error;
    }
    await import('execa').then(({ execa }) =>
      execa('git', ['add', '--', 'src/tracked-external.js'], {
        cwd: repo.path,
      }),
    );

    const index = await buildIndex(repo.path);
    const indexedPaths = index.files.map((file) => file.path);
    expect(indexedPaths).toContain('src/safe.js');
    expect(indexedPaths).not.toContain('src/tracked-external.js');
    expect(indexedPaths).not.toContain('src/untracked-external.js');
    expect(searchIndex(index, 'outsideSecret')).toEqual([]);

    const kernel = new ContextKernel(
      repo.path,
      index,
      compileTask('Inspect outsideSecret without leaving the repository'),
    );
    expect(kernel.initial().map((page) => page.path)).not.toContain(
      'src/tracked-external.js',
    );
    expect(() =>
      kernel.resolve({
        reason: 'Attempt to load an external tracked symlink',
        pathHint: 'src/tracked-external.js',
      }),
    ).toThrow('cannot be resolved');
    expect(() =>
      kernel.resolve({
        reason: 'Attempt to load an external untracked symlink',
        pathHint: 'src/untracked-external.js',
      }),
    ).toThrow('cannot be resolved');
  });

  it('refuses a Lattice metadata junction that escapes the repository', async (context) => {
    const repo = await repository({
      'src/safe.js': 'export const safe = true;\n',
    });
    const external = await repository({
      'keep.txt': 'external directory must remain untouched\n',
    });
    repositories.push(repo, external);
    try {
      symlinkSync(external.path, join(repo.path, '.lattice'), 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) {
        context.skip(`OS denied test junction creation (${code})`);
        return;
      }
      throw error;
    }

    await expect(buildIndex(repo.path)).rejects.toThrow(
      /metadata directory cannot be a symlink or junction/i,
    );
    expect(existsSync(join(external.path, 'index'))).toBe(false);
    expect(existsSync(join(external.path, 'sessions'))).toBe(false);
  });

  it('does not extract scripts from an external package manifest symlink', async (context) => {
    const repo = await repository({ 'src/safe.js': 'export const safe = true;\n' });
    const external = await repository({
      'package.json': JSON.stringify({ scripts: { test: 'external-command-sentinel' } }),
    });
    repositories.push(repo, external);
    try {
      symlinkSync(join(external.path, 'package.json'), join(repo.path, 'package.json'), 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) {
        context.skip(`OS denied test symlink creation (${code})`);
        return;
      }
      throw error;
    }
    const index = await buildIndex(repo.path);
    expect(index.scripts).toEqual({});
    expect(index.files.map((file) => file.path)).not.toContain('package.json');
  });
});

describe('adaptive exact context packs', () => {
  it('refuses content changed since indexing instead of attaching an old fingerprint', async () => {
    const repo = await repository({ 'src/value.js': 'export const value = 1;\n' });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    writeFileSync(join(repo.path, 'src/value.js'), 'export const value = 2;\n');
    const kernel = new ContextKernel(repo.path, index, compileTask('Inspect value'));
    expect(() => kernel.initial()).toThrow(/changed since indexing/);
    expect(() => kernel.resolve({ reason: 'read', pathHint: 'src/value.js' }))
      .toThrow(/changed since indexing/);
    expect(kernel.pages).toEqual([]);
  });

  it('refuses a directory replaced by an external junction after indexing', async (context) => {
    const repo = await repository({ 'src/value.js': 'export const value = 1;\n' });
    const external = await repository({ 'value.js': 'external-private-sentinel\n' });
    repositories.push(repo, external);
    const index = await buildIndex(repo.path);
    renameSync(join(repo.path, 'src'), join(repo.path, 'original-src'));
    try {
      symlinkSync(external.path, join(repo.path, 'src'), 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) {
        context.skip(`OS denied test junction creation (${code})`);
        return;
      }
      throw error;
    }
    const kernel = new ContextKernel(repo.path, index, compileTask('Inspect value'));
    expect(() => kernel.initial()).toThrow(/repository read escapes workspace/);
    expect(() => kernel.resolve({ reason: 'read', pathHint: 'src/value.js' }))
      .toThrow(/repository read escapes workspace/);
    expect(kernel.pages).toEqual([]);
  });

  it('grants a bounded exact slice and upgrades it to the full file on demand', async () => {
    const largeSource = [
      ...Array.from(
        { length: 900 },
        (_, index) => `const filler${index} = ${index};\n`,
      ),
      'function targetGoal() { return 1; }\n',
      'module.exports = { targetGoal };\n',
    ].join('');
    expect(largeSource.length).toBeGreaterThan(MAX_WHOLE_FILE_CONTEXT_CHARACTERS);
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node --test tests/*.test.js' },
      }),
      'tests/target.test.js':
        "const { targetGoal } = require('../src/large.js');\nconst test = require('node:test');\ntest('target goal', () => targetGoal());\n",
      'src/large.js': largeSource,
    });
    repositories.push(repo);
    const task = compileTask('Change targetGoal result');
    const kernel = new ContextKernel(repo.path, await buildIndex(repo.path), task);
    const initial = kernel.initial().find((page) => page.path === 'src/large.js')!;
    expect(initial.complete).toBe(false);
    expect(initial.content.length).toBeLessThan(largeSource.length);
    expect(initial.content).toContain('targetGoal');

    const upgraded = kernel.resolve({
      reason: 'Need the complete implementation file',
      pathHint: 'src/large.js',
    });
    expect(upgraded.complete).toBe(true);
    expect(upgraded.content).toBe(largeSource);
  });
});

describe('Sol context kernel', () => {
  it('prioritizes the CommonJS runtime closure and deduplicates TypeScript mirrors', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        scripts: { test: 'node --test tests/*.test.js' },
      }),
      'tests/token.test.js': [
        "const { TokenRepository } = require('../src/auth/token-repository.js');",
        "const { AuthService } = require('../src/auth/service.js');",
        "const { events } = require('../src/auth/audit.js');",
        "const { login } = require('../src/auth/login.js');",
        'TokenRepository; AuthService; events; login;',
      ].join('\n'),
      'src/auth/token-repository.js': 'module.exports = { TokenRepository: class {} };\n',
      'src/auth/token-repository.ts': 'export class TokenRepository {}\n',
      'src/auth/service.js': [
        "const { TokenRepository } = require('./token-repository.js');",
        "const { recordAudit } = require('./audit.js');",
        'module.exports = { AuthService: class {} };',
      ].join('\n'),
      'src/auth/service.ts': 'export class AuthService {}\n',
      'src/auth/audit.js': 'module.exports = { events: [], recordAudit() {} };\n',
      'src/auth/audit.ts': 'export const events = [];\n',
      'src/auth/login.js': 'module.exports = { login() { return true; } };\n',
      'src/auth/login.ts': 'export function login() { return false; }\n',
      'src/unrelated/token-types.ts': 'export type ResetToken = string;\n',
    });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    const task = compileTask(
      'Fix reset token consumption and password reset audit behavior while preserving login.',
    );
    const selected = initialContextFiles(index, task).map(({ file }) => file.path);
    expect(selected.slice(0, 5)).toEqual([
      'tests/token.test.js',
      'src/auth/token-repository.js',
      'src/auth/service.js',
      'src/auth/audit.js',
      'src/auth/login.js',
    ]);
    expect(selected).not.toContain('src/auth/token-repository.ts');
    expect(selected).not.toContain('src/auth/service.ts');
    expect(selected).not.toContain('src/auth/audit.ts');
    expect(selected).not.toContain('src/auth/login.ts');
  });

  it('enforces page budgets and deduplicates stable pages', async () => {
    const repo = await repository({
      'src/token-a.js': 'export const tokenA = 1;\n',
      'src/token-b.js': 'export const tokenB = 2;\n',
      'tests/token.test.js': 'tokenA; tokenB;\n',
    });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    const task = compileTask('Fix token tests');
    task.budget.maxPages = 1;
    const kernel = new ContextKernel(repo.path, index, task);
    const pages = kernel.initial();
    expect(pages).toHaveLength(1);
    kernel.add(pages[0]);
    expect(kernel.pages).toHaveLength(1);
  });

  it('resolves a JavaScript hint to TypeScript and records a page fault', async () => {
    const repo = await repository({
      'src/auth/audit.ts': 'export function recordAudit() {}\n',
    });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    const kernel = new ContextKernel(repo.path, index, compileTask('Inspect audit behavior'));
    const loaded = kernel.resolve({
      reason: 'Need the audit implementation',
      pathHint: 'src/auth/audit.js',
    });
    expect(loaded.path).toBe('src/auth/audit.ts');
    expect(kernel.faults).toHaveLength(1);
  });

  it('still faults when a dependency is genuinely outside the initial runtime closure', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        scripts: { test: 'node --test tests/*.test.js' },
      }),
      'tests/token.test.js': "require('../src/token.js');\n",
      'src/token.js': 'module.exports = { token: true };\n',
      'src/optional.js': 'module.exports = { optional: true };\n',
    });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    const kernel = new ContextKernel(repo.path, index, compileTask('Fix token behavior'));
    expect(kernel.initial().map((page) => page.path)).not.toContain('src/optional.js');
    expect(
      kernel.resolve({
        reason: 'The optional implementation is now required',
        pathHint: 'src/optional.js',
      }).path,
    ).toBe('src/optional.js');
    expect(kernel.faults).toHaveLength(1);
  });

  it('rejects an unresolved traversal request', async () => {
    const repo = await repository({ 'src/a.ts': 'export const a = 1;\n' });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    const kernel = new ContextKernel(repo.path, index, compileTask('Inspect a'));
    expect(() =>
      kernel.resolve({ reason: 'invalid', pathHint: '../secret.ts' }),
    ).toThrow('cannot be resolved');
  });

  it('evicts a low-value initial page to retain an explicit fault page', async () => {
    const repo = await repository({
      'src/token.js': 'export const token = 1;\n',
      'src/audit.js': 'export const audit = 1;\n',
    });
    repositories.push(repo);
    const index = await buildIndex(repo.path);
    const task = compileTask('Fix token');
    task.budget.maxPages = 1;
    const kernel = new ContextKernel(repo.path, index, task);
    expect(kernel.initial()[0].path).toBe('src/token.js');
    kernel.resolve({ reason: 'Explicitly need audit', pathHint: 'src/audit.js' });
    expect(kernel.pages.map((page) => page.path)).toEqual(['src/audit.js']);
  });
});
