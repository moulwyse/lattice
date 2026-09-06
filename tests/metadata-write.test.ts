import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import { writeJson } from '../src/core.js';

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lattice-metadata-write-'));
  directories.push(root);
  const target = join(root, 'metadata.json');
  const outside = join(root, 'external.txt');
  writeFileSync(outside, 'external-private-sentinel\n');
  return { root, target, outside };
}
afterEach(async () => {
  for (const root of directories.splice(0)) await removeDirectoryWithRetry(root);
});

describe('metadata writes', () => {
  it('does not overwrite a file hard-linked to the destination', () => {
    const { target, outside } = fixture();
    linkSync(outside, target);
    writeJson(target, { status: 'ready' });
    expect(readFileSync(outside, 'utf8')).toBe('external-private-sentinel\n');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'ready' });
  });

  it('does not follow a symbolic link at the destination', (context) => {
    const { target, outside } = fixture();
    try {
      symlinkSync(outside, target, 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) {
        context.skip(`OS denied test symlink creation (${code})`);
        return;
      }
      throw error;
    }
    writeJson(target, { status: 'ready' });
    expect(readFileSync(outside, 'utf8')).toBe('external-private-sentinel\n');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'ready' });
  });

  it('keeps the previous artifact when serialization fails and leaves no temporary files', () => {
    const { root, target } = fixture();
    writeJson(target, { status: 'previous' });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => writeJson(target, cyclic)).toThrow();
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'previous' });
    expect(readdirSync(root).sort()).toEqual(['external.txt', 'metadata.json']);
  });

  it('cleans its temporary file if the destination is a directory', () => {
    const { root, target } = fixture();
    mkdirSync(target);
    expect(() => writeJson(target, { status: 'ready' })).toThrow();
    expect(statSync(target).isDirectory()).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['external.txt', 'metadata.json']);
  });

  it.skipIf(process.platform === 'win32')('creates private artifacts on POSIX', () => {
    const { target } = fixture();
    writeJson(target, { status: 'ready' });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
