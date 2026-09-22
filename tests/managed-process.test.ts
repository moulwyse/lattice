import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import { runInheritedProcess, runManagedProcess } from '../src/managed-process.js';

const managedProcessModule = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'managed-process.js',
);
const temporaryPaths: string[] = [];
afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await removeDirectoryWithRetry(path);
});

describe('managed processes', () => {
  it('reports a missing executable as a rejection instead of crashing the process', async () => {
    await expect(
      runManagedProcess('lattice-definitely-missing-command', ['--version']),
    ).rejects.toThrow(/failed to start child process: lattice-definitely-missing-command/);
    await expect(
      runInheritedProcess('lattice-definitely-missing-command', ['--version']),
    ).rejects.toThrow(/failed to start foreground process/);
    // An unhandled child 'error' event would terminate the test worker here.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('leaves Ctrl+C to an interactive child instead of forwarding or killing it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lattice-sigint-'));
    temporaryPaths.push(directory);
    const child = join(directory, 'child.mjs');
    writeFileSync(
      child,
      "process.on('SIGINT', () => {});\nsetTimeout(() => process.exit(0), 1500);\n",
    );
    // The launcher runs in its own Node process so the simulated terminal
    // Ctrl+C cannot reach the test runner's own SIGINT handling.
    const launcher = join(directory, 'launcher.mjs');
    writeFileSync(
      launcher,
      [
        `import { runInheritedProcess } from ${JSON.stringify(pathToFileURL(managedProcessModule).href)};`,
        "setTimeout(() => process.emit('SIGINT', 'SIGINT'), 400);",
        `const result = await runInheritedProcess(process.execPath, [${JSON.stringify(child)}]);`,
        'console.log(JSON.stringify({ exitCode: result.exitCode, signal: result.signal }));',
      ].join('\n'),
    );
    const result = await runManagedProcess(process.execPath, [launcher], { timeoutMs: 20_000 });
    expect(JSON.parse(result.stdout.trim())).toEqual({ exitCode: 0, signal: null });
  });
});
