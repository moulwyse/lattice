import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { posixUserPathStore } from '../src/posix-user-path.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(shell = 'bash') {
  const home = mkdtempSync(join(tmpdir(), 'lattice-path-'));
  roots.push(home);
  const directory = join(home, "it's a shim");
  return { home, directory, store: posixUserPathStore(directory, { HOME: home, SHELL: `/bin/${shell}` }) };
}
test.each(['bash', 'zsh', 'fish'])('PATH lifecycle is idempotent for %s', async (shell) => {
  const { home, directory, store } = fixture(shell);
  const file = shell === 'bash' ? '.bashrc' : shell === 'zsh' ? '.zshrc' : '.config/fish/conf.d/lattice-codex.fish';
  mkdirSync(join(home, '.config/fish/conf.d'), { recursive: true });
  const path = join(home, file);
  writeFileSync(path, '# user settings\n');
  expect(await store.read()).toBeNull();
  await store.write(directory);
  const installed = readFileSync(path, 'utf8');
  await store.write(directory);
  expect(readFileSync(path, 'utf8')).toBe(installed);
  expect(await store.read()).toBe(directory);
  writeFileSync(path, installed + '# added later\n');
  await store.write(null);
  expect(readFileSync(path, 'utf8')).toBe('# user settings\n# added later\n');
  expect(await store.read()).toBeNull();
});
test('uses existing Bash login profile and refuses edited managed blocks', async () => {
  const { home, directory } = fixture();
  writeFileSync(join(home, '.bash_profile'), '# login\n');
  const store = posixUserPathStore(directory, { HOME: home, SHELL: '/bin/bash' });
  await store.write(directory);
  expect(readFileSync(join(home, '.bash_profile'), 'utf8')).toContain('Lattice Codex PATH');
  const path = join(home, '.bashrc');
  const edited = readFileSync(path, 'utf8').replace('export PATH=', 'export OTHER=');
  writeFileSync(path, edited);
  await expect(store.write(null)).rejects.toThrow('modified');
  expect(readFileSync(path, 'utf8')).toBe(edited);
});
test('rolls back earlier profile writes if a later file cannot be written', async () => {
  const { home, directory, store } = fixture();
  writeFileSync(join(home, '.bashrc'), '# original\n');
  mkdirSync(join(home, '.profile'));
  await expect(store.write(directory)).rejects.toThrow();
  expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('# original\n');
});
test('rejects unsupported shells without changes', () => {
  expect(() => fixture('nu')).toThrow('unsupported shell');
});
