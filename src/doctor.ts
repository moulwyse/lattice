import { accessSync, constants } from 'node:fs';
import { execa } from 'execa';
import { metadata } from './core.js';
import { resolveCodexModelSettings } from './model-settings.js';

async function available(command: string, arguments_: string[], cwd?: string) {
  try {
    return await execa(command, arguments_, { cwd, reject: false, timeout: 10_000 });
  } catch {
    return null;
  }
}

export async function doctor(workspace: string) {
  const modelSettings = resolveCodexModelSettings(workspace);
  const git = await available('git', ['--version']);
  const repository = await available('git', ['rev-parse', '--is-inside-work-tree'], workspace);
  const isRepository = repository?.exitCode === 0;
  const status = isRepository
    ? (
        await execa('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: workspace,
        })
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean)
    : [];
  let writable = true;
  try {
    accessSync(metadata(workspace), constants.W_OK);
  } catch {
    writable = false;
  }
  const codex = await available('codex', ['login', 'status']);
  const worktree = isRepository
    ? await available('git', ['worktree', 'list', '--porcelain'], workspace)
    : null;
  const attributes = isRepository
    ? await available('git', ['check-attr', '-a', '--', '.'], workspace)
    : null;
  const autocrlf = isRepository
    ? await available('git', ['config', '--get', 'core.autocrlf'], workspace)
    : null;

  return {
    node: {
      version: process.version,
      ok: Number(process.versions.node.split('.')[0]) >= 20,
    },
    git: {
      available: git?.exitCode === 0,
      version: git?.stdout ?? null,
      repository: isRepository,
      status,
    },
    worker: {
      configured: 'codex',
      authenticationAvailable: codex?.exitCode === 0,
      authenticationHint: codex?.exitCode === 0 ? null : 'Run: codex login',
      modelConfiguration: {
        modelOverride: modelSettings.model ?? null,
        reasoningEffortOverride: modelSettings.reasoningEffort ?? null,
        modelSource: modelSettings.modelSource,
        reasoningEffortSource: modelSettings.reasoningEffortSource,
        modelPolicy: modelSettings.modelPolicy,
        modelPolicySource: modelSettings.modelPolicySource,
        policyRisk: modelSettings.policyRisk,
      },
    },
    writePermissions: writable,
    worktreeSupport: worktree?.exitCode === 0,
    commandAllowlist: [
      'npm test',
      'npm run test',
      'npm run build',
      'npm run lint',
      'npx tsc --noEmit',
      'npx vitest run',
    ],
    lineEndings: {
      autocrlf: autocrlf?.stdout || null,
      attributes: attributes?.stdout || null,
    },
  };
}
