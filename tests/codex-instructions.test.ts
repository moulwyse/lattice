import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import {
  configuredDeveloperInstructions,
  injectRoutingInstructions,
  parseTomlString,
} from '../src/codex-command.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await removeDirectoryWithRetry(path);
});

function codexHome(config: string) {
  const home = mkdtempSync(join(tmpdir(), 'lattice-codex-home-'));
  temporaryPaths.push(home);
  writeFileSync(join(home, 'config.toml'), config, 'utf8');
  return home;
}

describe('TOML strings', () => {
  it('parses basic, literal and multi-line strings with escapes', () => {
    expect(parseTomlString('"a\\tb\\n\\"c\\" \\u00e9"', 0)?.value).toBe('a\tb\n"c" é');
    expect(parseTomlString("'C:\\\\no\\escapes'", 0)?.value).toBe('C:\\\\no\\escapes');
    expect(parseTomlString('"""\nline one\nline two"""', 0)?.value).toBe('line one\nline two');
    expect(parseTomlString("'''\r\nraw \\n text'''", 0)?.value).toBe('raw \\n text');
    expect(parseTomlString('"""joined \\\n    words"""', 0)?.value).toBe('joined words');
    expect(parseTomlString('"unterminated', 0)).toBeNull();
    expect(parseTomlString('bare', 0)).toBeNull();
  });

  it('reads only unambiguous top-level developer instructions', () => {
    expect(configuredDeveloperInstructions('model = "x"\n')).toEqual({ kind: 'none' });
    expect(
      configuredDeveloperInstructions('developer_instructions = """\nFirst.\nSecond.\n""" # note\n'),
    ).toEqual({ kind: 'value', value: 'First.\nSecond.\n' });
    expect(
      configuredDeveloperInstructions('[profiles.work]\ndeveloper_instructions = "profile only"\n'),
    ).toEqual({ kind: 'unreadable' });
    expect(configuredDeveloperInstructions('developer_instructions = 42\n')).toEqual({
      kind: 'unreadable',
    });
  });
});

describe('Codex routing instructions', () => {
  it('prepends the override so it never lands after a subcommand terminator', () => {
    const home = codexHome('model = "gpt"\n');
    const args = injectRoutingInstructions(['exec', '--', 'prompt text'], 'ROUTING', {
      cwd: home,
      env: { CODEX_HOME: home },
    });
    expect(args).toEqual(['-c', 'developer_instructions="ROUTING"', 'exec', '--', 'prompt text']);
  });

  it('merges multi-line user instructions instead of truncating them', () => {
    const home = codexHome('developer_instructions = """\nAlways write tests.\nPrefer small diffs."""\n');
    const [flag, value] = injectRoutingInstructions([], 'ROUTING', {
      cwd: home,
      env: { CODEX_HOME: home },
    });
    expect(flag).toBe('-c');
    expect(JSON.parse(value.slice('developer_instructions='.length))).toBe(
      'Always write tests.\nPrefer small diffs.\n\nROUTING',
    );
  });

  it('leaves arguments untouched when configured instructions cannot be merged safely', () => {
    const home = codexHome('[profiles.work]\ndeveloper_instructions = "keep me"\n');
    expect(
      injectRoutingInstructions(['--profile', 'work'], 'ROUTING', { cwd: home, env: { CODEX_HOME: home } }),
    ).toEqual(['--profile', 'work']);
  });

  it('prefers project configuration over the user configuration', () => {
    const home = codexHome('developer_instructions = "user"\n');
    const project = mkdtempSync(join(tmpdir(), 'lattice-codex-project-'));
    temporaryPaths.push(project);
    mkdirSync(join(project, '.codex'));
    writeFileSync(join(project, '.codex', 'config.toml'), "developer_instructions = 'project'\n");
    const [, value] = injectRoutingInstructions([], 'ROUTING', { cwd: project, env: { CODEX_HOME: home } });
    expect(JSON.parse(value.slice('developer_instructions='.length))).toBe('project\n\nROUTING');
  });
});
