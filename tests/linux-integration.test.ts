import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { posixUserPathStore } from '../src/posix-user-path.js';
import { enableCodexIntegration, disableCodexIntegration, codexIntegrationStatus } from '../src/codex-integration.js';

test.skipIf(process.platform !== 'linux')('Linux enable, shell launch, hooks, repeat enable and disable', async () => {
  const root = mkdtempSync(join(tmpdir(), "lattice linux '"));
  try {
    const cliPath = join(root, 'cli.mjs');
    writeFileSync(cliPath, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);\n');
    const native = join(root, 'codex');
    writeFileSync(native, '#!/bin/sh\nprintf "codex-cli test\\n"\n');
    chmodSync(native, 0o755);
    const env = { HOME: root, SHELL: '/bin/bash', CODEX_HOME: join(root, '.codex'), PATH: root };
    const options = { cliPath, env, paths: { stateDirectory: join(root, 'state') }, nativeCandidatePaths: [native], registerMcp: false, registerHooks: true };
    const enabled = await enableCodexIntegration(options);
    expect(enabled.state.nativeTarget.command).toBe(native);
    expect(enabled.state.hooks?.runnerPath).toBeUndefined();
    expect(existsSync(join(root, '.codex', 'hooks.json'))).toBe(true);
    expect(statSync(enabled.state.shimPaths.codex[0]).mode & 0o111).toBeTruthy();
    const run = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', '. "$HOME/.bashrc"; codex "$@"', 'test', 'space arg', "quote'", '$HOME;echo nope'], { env, encoding: 'utf8' });
    expect(run.status).toBe(7);
    expect(JSON.parse(run.stdout)).toEqual(['codex', 'space arg', "quote'", '$HOME;echo nope']);
    const raw = spawnSync(enabled.state.shimPaths.raw[0], ['x'], { env, encoding: 'utf8' });
    expect(JSON.parse(raw.stdout)).toEqual(['codex', '--raw', 'x']);
    expect((await enableCodexIntegration(options)).changed).toBe(false);
    const switched = { ...options, env: { ...env, SHELL: '/bin/fish' } };
    expect((await codexIntegrationStatus(switched)).enabled).toBe(true);
    await disableCodexIntegration(switched);
    expect(readFileSync(join(root, '.bashrc'), 'utf8')).not.toContain('Lattice');
    expect(existsSync(enabled.state.shimPaths.codex[0])).toBe(false);
    expect(existsSync(join(root, '.codex', 'hooks.json'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'linux').each(['bash', 'zsh', 'fish'])('Linux %s startup block preserves literal paths and wins PATH precedence', async (shell) => {
  const root = mkdtempSync(join(tmpdir(), "lattice ' $ ; "));
  try {
    const store = posixUserPathStore(root, { HOME: root, SHELL: '/bin/' + shell });
    await store.write(root);
    const env = { ...process.env, HOME: root, PATH: '/usr/bin:/bin:' + root, LATTICE_PROFILE: store.files[0] };
    const source = shell === 'fish' ? 'source "$LATTICE_PROFILE"; source "$LATTICE_PROFILE"; printf "%s" "$PATH[1]"' : '. "$LATTICE_PROFILE"; . "$LATTICE_PROFILE"; printf "%s" "$PATH"';
    const run = spawnSync(shell, ['-c', source], { env, encoding: 'utf8' });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(shell === 'fish' ? root : root + ':' + env.PATH);
    await store.write(null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
