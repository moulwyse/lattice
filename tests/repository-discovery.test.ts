import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import {
  discoverRepository,
  unsafeAutomaticRoot,
} from '../src/repository.js';
import { repository, type TestRepository } from './helpers.js';

describe('repository discovery', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  test('resolves a Git root from a nested working directory', async () => {
    const fixture: TestRepository = await repository({
      'src/index.ts': 'export const value = 1;\n',
    });
    cleanups.push(fixture.cleanup);
    const nested = join(fixture.path, 'src', 'nested', 'deeper');
    mkdirSync(nested, { recursive: true });

    const result = await discoverRepository(nested);

    expect(result).toEqual({
      safe: true,
      root: realpathSync(fixture.path),
      source: 'git',
    });
  });

  test('uses the nearest explicit Lattice marker outside Git', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'lattice-v2-marker-'));
    cleanups.push(() => removeDirectoryWithRetry(fixture));
    writeFileSync(join(fixture, 'lattice.config.json'), '{}\n');
    const nested = join(fixture, 'packages', 'feature', 'src');
    mkdirSync(nested, { recursive: true });

    const result = await discoverRepository(nested);

    expect(result).toEqual({
      safe: true,
      root: realpathSync(fixture),
      source: 'lattice-config',
    });
  });

  test('classifies broad automatic roots as unsafe without rejecting a normal project', () => {
    expect(unsafeAutomaticRoot(parse(homedir()).root)).toBe(true);
    expect(unsafeAutomaticRoot(homedir())).toBe(true);
    expect(unsafeAutomaticRoot(dirname(homedir()))).toBe(true);
    expect(
      unsafeAutomaticRoot(resolve(tmpdir(), 'lattice-safe-project', 'repository')),
    ).toBe(false);
  });
});
