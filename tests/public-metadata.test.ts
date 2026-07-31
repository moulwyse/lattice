import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

    expect(packageJson.version).toBe('0.1.0');
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
});
