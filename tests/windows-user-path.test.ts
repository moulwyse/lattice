import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsUserPathStore } from '../src/codex-integration.js';

// A throwaway key: the real HKCU\Environment\Path is never touched.
const key = `Software\\LatticeTest\\${randomUUID()}`;
const location = { key, value: 'Path', broadcast: false };

async function registryValue() {
  const result = await execa('reg', ['query', `HKCU\\${key}`, '/v', 'Path'], { reject: false });
  const match = result.stdout.match(/Path\s+(REG_\w+)\s+(.*)$/m);
  return match ? { type: match[1], data: match[2].trim() } : null;
}

afterEach(async () => {
  if (process.platform === 'win32') {
    await execa('reg', ['delete', `HKCU\\Software\\LatticeTest`, '/f'], { reject: false });
  }
});

describe.skipIf(process.platform !== 'win32')('Windows user PATH store', () => {
  it('round-trips %VAR% entries unexpanded as REG_EXPAND_SZ', async () => {
    await execa('reg', [
      'add', `HKCU\\${key}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ',
      '/d', '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools', '/f',
    ]);
    const store = windowsUserPathStore(process.env, location);
    const original = await store.read();
    expect(original).toBe('%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools');

    await store.write(`C:\\Lattice\\bin;${original}`);
    expect(await registryValue()).toEqual({
      type: 'REG_EXPAND_SZ',
      data: 'C:\\Lattice\\bin;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools',
    });

    await store.write(original);
    expect(await registryValue()).toEqual({
      type: 'REG_EXPAND_SZ',
      data: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools',
    });
  }, 60_000);

  it('keeps an existing REG_SZ value as REG_SZ and removes a null value', async () => {
    await execa('reg', ['add', `HKCU\\${key}`, '/v', 'Path', '/t', 'REG_SZ', '/d', 'C:\\Plain', '/f']);
    const store = windowsUserPathStore(process.env, location);
    await store.write('C:\\Lattice\\bin;C:\\Plain');
    expect(await registryValue()).toEqual({ type: 'REG_SZ', data: 'C:\\Lattice\\bin;C:\\Plain' });
    await store.write(null);
    expect(await registryValue()).toBeNull();
    expect(await store.read()).toBeNull();
  }, 60_000);
});
