import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import {
  parseReasoningEffort,
  resolveCodexModelSettings,
} from '../src/model-settings.js';
import { codexThreadOptions } from '../src/worker.js';

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await removeDirectoryWithRetry(path);
});

function workspace(config?: unknown) {
  const path = mkdtempSync(join(tmpdir(), 'lattice-model-settings-'));
  paths.push(path);
  if (config !== undefined) {
    writeFileSync(
      join(path, 'lattice.config.json'),
      `${JSON.stringify(config)}\n`,
      'utf8',
    );
  }
  return path;
}

describe('Codex model synchronization', () => {
  it('inherits the normal Codex configuration by default', () => {
    const inherited = resolveCodexModelSettings(workspace());
    expect(inherited).toEqual({
      modelSource: 'codex-config',
      reasoningEffortSource: 'codex-config',
      modelPolicy: 'inherit',
      modelPolicySource: 'default',
      policyRisk: 'medium',
    });
    expect(codexThreadOptions('C:/repo', inherited)).toEqual({
      workingDirectory: 'C:/repo',
      sandboxMode: 'read-only',
    });
    expect(
      resolveCodexModelSettings(
        workspace({ model: 'inherit', reasoningEffort: 'inherit' }),
      ),
    ).toEqual({
      modelSource: 'codex-config',
      reasoningEffortSource: 'codex-config',
      modelPolicy: 'inherit',
      modelPolicySource: 'default',
      policyRisk: 'medium',
    });
  });

  it('supports persistent Lattice overrides and higher-priority CLI overrides', () => {
    const path = workspace({
      model: 'gpt-project',
      reasoningEffort: 'low',
    });
    expect(resolveCodexModelSettings(path)).toEqual({
      model: 'gpt-project',
      reasoningEffort: 'low',
      modelSource: 'lattice-config',
      reasoningEffortSource: 'lattice-config',
      modelPolicy: 'inherit',
      modelPolicySource: 'default',
      policyRisk: 'medium',
    });
    expect(
      codexThreadOptions('C:/repo', resolveCodexModelSettings(path)),
    ).toEqual({
      model: 'gpt-project',
      modelReasoningEffort: 'low',
      workingDirectory: 'C:/repo',
      sandboxMode: 'read-only',
    });
    expect(
      resolveCodexModelSettings(path, {
        model: 'gpt-cli',
        reasoningEffort: 'high',
      }),
    ).toEqual({
      model: 'gpt-cli',
      reasoningEffort: 'high',
      modelSource: 'cli',
      reasoningEffortSource: 'cli',
      modelPolicy: 'inherit',
      modelPolicySource: 'default',
      policyRisk: 'medium',
    });
  });

  it('routes ordinary work to Terra and leaves high-risk work on shared Codex defaults', () => {
    const path = workspace({
      model: 'inherit',
      reasoningEffort: 'inherit',
      modelPolicy: 'adaptive',
    });
    expect(resolveCodexModelSettings(path, {}, 'medium')).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      modelSource: 'adaptive-policy',
      reasoningEffortSource: 'adaptive-policy',
      modelPolicy: 'adaptive',
      policyRisk: 'medium',
    });
    expect(resolveCodexModelSettings(path, {}, 'high')).toMatchObject({
      modelSource: 'codex-config',
      reasoningEffortSource: 'codex-config',
      modelPolicy: 'adaptive',
      policyRisk: 'high',
    });
    expect(resolveCodexModelSettings(path, {}, 'high').model).toBeUndefined();
  });

  it('prefers the active Codex /model session over adaptive routing', () => {
    const path = workspace({
      model: 'inherit',
      reasoningEffort: 'inherit',
      modelPolicy: 'adaptive',
    });
    mkdirSync(join(path, '.lattice'));
    writeFileSync(
      join(path, '.lattice', 'codex-session.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId: 'session-1',
        workspace: path,
        model: 'gpt-selected-in-codex',
        reasoningEffort: null,
        hookEvent: 'UserPromptSubmit',
        updatedAt: new Date().toISOString(),
      })}\n`,
    );

    expect(resolveCodexModelSettings(path, {}, 'medium')).toMatchObject({
      model: 'gpt-selected-in-codex',
      modelSource: 'codex-session',
      reasoningEffortSource: 'codex-config',
      modelPolicy: 'adaptive',
    });
    expect(resolveCodexModelSettings(path, {}, 'medium')).not.toHaveProperty(
      'reasoningEffort',
    );
  });

  it('rejects unsupported reasoning values before starting a model turn', () => {
    expect(() => parseReasoningEffort('ultra')).toThrow(
      /minimal, low, medium, high, xhigh/,
    );
    expect(() =>
      resolveCodexModelSettings(workspace({ reasoningEffort: 'maximum' })),
    ).toThrow(/reasoning effort/);
  });
});
