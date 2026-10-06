import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enableClaudeIntegration, disableClaudeIntegration, claudeIntegrationStatus } from '../src/claude-integration.js';

const homes: string[] = [];
function home() {
  const value = mkdtempSync(join(tmpdir(), 'lattice-user-integration-'));
  homes.push(value);
  return value;
}
afterEach(() => { for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('Claude user integration', () => {
  it('enables for all projects without indexing home and preserves user settings on disable', async () => {
    const directory = home();
    mkdirSync(join(directory, '.claude'));
    const mcp = { projects: { existing: {} }, mcpServers: { other: { command: 'other' } } };
    const settings = { model: 'haiku', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] } };
    writeFileSync(join(directory, '.claude.json'), JSON.stringify(mcp));
    writeFileSync(join(directory, '.claude', 'settings.json'), JSON.stringify(settings));
    const location = { scope: 'user' as const, home: directory };
    const options = { ...location, workspace: directory, cliPath: join(directory, 'dist', 'cli.js') };
    expect((await enableClaudeIntegration(options)).changed).toBe(true);
    expect((await claudeIntegrationStatus(directory, location)).enabled).toBe(true);
    expect((await enableClaudeIntegration(options)).changed).toBe(false);
    expect(existsSync(join(directory, '.lattice'))).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, '.claude', 'settings.json'), 'utf8'))).not.toHaveProperty('enabledMcpjsonServers');
    await disableClaudeIntegration(directory, location);
    expect(JSON.parse(readFileSync(join(directory, '.claude.json'), 'utf8'))).toEqual(mcp);
    expect(JSON.parse(readFileSync(join(directory, '.claude', 'settings.json'), 'utf8'))).toEqual(settings);
  });

  it('preserves a conflicting server and writes no ownership receipt', async () => {
    const directory = home();
    const mcp = { mcpServers: { lattice: { command: 'someone-else' } } };
    writeFileSync(join(directory, '.claude.json'), JSON.stringify(mcp));
    await expect(enableClaudeIntegration({ scope: 'user', home: directory, workspace: directory, cliPath: join(directory, 'cli.js') })).rejects.toThrow('already exists');
    expect(JSON.parse(readFileSync(join(directory, '.claude.json'), 'utf8'))).toEqual(mcp);
    expect(existsSync(join(directory, '.claude', 'lattice-integration.json'))).toBe(false);
  });
});
