import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, test } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const scanner = resolve(projectRoot, 'scripts', 'scan-public-export.mjs');
const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lattice-public-scan-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(scanner, join(root, 'scripts', 'scan-public-export.mjs'));
  writeFileSync(join(root, 'README.md'), '# Public fixture\n');
  return root;
}

function generatedDirectories(root: string) {
  for (const directory of ['.git', '.lattice', 'node_modules', 'dist']) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'generated.txt'), 'generated\n');
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('public export scanner modes', () => {
  test('source-checkout mode ignores only expected generated directories', async () => {
    const root = fixture();
    generatedDirectories(root);

    const result = await execa(
      process.execPath,
      [join(root, 'scripts', 'scan-public-export.mjs'), '--source-checkout'],
      { cwd: root },
    );

    expect(result.stdout).toContain('Scan mode: source checkout');
    expect(result.stdout).toContain('Public export scan passed');
  });

  test('strict mode continues to reject generated directories', async () => {
    const root = fixture();
    generatedDirectories(root);

    const error = await execa(
      process.execPath,
      [join(root, 'scripts', 'scan-public-export.mjs')],
      { cwd: root, reject: false },
    );

    expect(error.exitCode).toBe(1);
    expect(error.stderr).toContain('[forbidden-directory] .git');
    expect(error.stderr).toContain('[forbidden-directory] node_modules');
  });

  test('source-checkout mode still rejects private workspace directories', async () => {
    const root = fixture();
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'config.toml'), 'private = true\n');

    const error = await execa(
      process.execPath,
      [join(root, 'scripts', 'scan-public-export.mjs'), '--source-checkout'],
      { cwd: root, reject: false },
    );

    expect(error.exitCode).toBe(1);
    expect(error.stderr).toContain('[forbidden-directory] .codex');
  });

  test('source-checkout mode still detects secrets in source files', async () => {
    const root = fixture();
    const secretField = ['api', 'key'].join('_');
    const fakeToken = ['sk', 'example-secret-value-1234567890'].join('-');
    writeFileSync(
      join(root, 'unsafe.txt'),
      `${secretField} = "${fakeToken}"\n`,
    );

    const error = await execa(
      process.execPath,
      [join(root, 'scripts', 'scan-public-export.mjs'), '--source-checkout'],
      { cwd: root, reject: false },
    );

    expect(error.exitCode).toBe(1);
    expect(error.stderr).toContain('[openai-style-token] unsafe.txt');
  });
});
