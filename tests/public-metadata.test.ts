import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'dist', 'cli.js');

describe('public release metadata', () => {
  test('package metadata preserves authorship and disables publication', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      version: string;
      private: boolean;
      license: string;
      author: { name: string; url: string };
      repository: { url: string };
    };

    expect(packageJson.version).toBe('0.1.1');
    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe('Apache-2.0');
    expect(packageJson.author).toEqual({
      name: 'Moulwyse',
      url: 'https://github.com/moulwyse',
    });
    expect(packageJson.repository.url).toContain('github.com/moulwyse/lattice');
  });

  test('--version identifies Lattice and its original author', async () => {
    const output = await execa(process.execPath, [cli, '--version'], { cwd: root });
    expect(output.stdout).toBe('Lattice 0.1.0 by Moulwyse');
  });

  test('--about prints the canonical provenance block', async () => {
    const output = await execa(process.execPath, [cli, '--about'], { cwd: root });
    expect(output.stdout).toBe(`Lattice 0.1.0

Originally created and developed by Moulwyse.
Original author: https://github.com/moulwyse
Canonical repository: https://github.com/moulwyse/lattice
License: Apache-2.0`);
  });

  test('the CLI runs when npm invokes it through a linked package path', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'lattice-linked-cli-'));
    const linkedRoot = join(temporaryRoot, 'lattice-v2');
    try {
      symlinkSync(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      const output = await execa(
        process.execPath,
        [resolve(linkedRoot, 'dist', 'cli.js'), '--version'],
        { cwd: linkedRoot },
      );
      expect(output.stdout).toBe('Lattice 0.1.0 by Moulwyse');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
