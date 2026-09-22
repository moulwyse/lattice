import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { bundledClaudeExecutable } from './claude-command.js';
import { resolveCodexModelSettings } from './model-settings.js';
import { repositoryRoot } from './repository.js';
import { compileTask, withRepositoryVerification } from './task.js';

async function available(command: string, arguments_: string[], cwd?: string) {
  try {
    return await execa(command, arguments_, { cwd, reject: false, timeout: 10_000 });
  } catch {
    return null;
  }
}

/** Mirrors package.json engines: ^20.19.0 || >=22.12.0. */
export function supportedNodeVersion(version: string) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;
}

function bundledClaude() {
  try {
    return bundledClaudeExecutable();
  } catch {
    return null;
  }
}

/** Diagnostics are read-only: nothing is created in the inspected directory. */
export async function doctor(requestedWorkspace: string) {
  const workspace = await repositoryRoot(requestedWorkspace);
  const modelSettings = resolveCodexModelSettings(workspace);
  const git = await available('git', ['--version']);
  const repository = await available('git', ['rev-parse', '--is-inside-work-tree'], workspace);
  const isRepository = repository?.exitCode === 0;
  const status = isRepository
    ? ((await available('git', ['status', '--porcelain', '--untracked-files=all'], workspace))
        ?.stdout.split(/\r?\n/)
        .filter(Boolean) ?? [])
    : [];
  const metadataDirectory = join(workspace, '.lattice');
  let writable = true;
  try {
    accessSync(existsSync(metadataDirectory) ? metadataDirectory : workspace, constants.W_OK);
  } catch {
    writable = false;
  }
  const codex = await available('codex', ['login', 'status']);
  const claude = bundledClaude();
  const worktree = isRepository
    ? await available('git', ['worktree', 'list', '--porcelain'], workspace)
    : null;
  const attributes = isRepository
    ? await available('git', ['check-attr', '-a', '--', '.'], workspace)
    : null;
  const autocrlf = isRepository
    ? await available('git', ['config', '--get', 'core.autocrlf'], workspace)
    : null;
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }).scripts ?? {};
  } catch {
    // A package manifest is optional.
  }

  return {
    workspace,
    node: {
      version: process.version,
      ok: supportedNodeVersion(process.version),
      required: '^20.19.0 || >=22.12.0',
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
    workers: {
      codex: {
        available: codex !== null && codex.exitCode !== undefined,
        authenticated: codex?.exitCode === 0,
      },
      claude: {
        bundledExecutable: claude,
        available: claude !== null && existsSync(claude),
      },
    },
    writePermissions: writable,
    worktreeSupport: worktree?.exitCode === 0,
    commandAllowlist: withRepositoryVerification(compileTask('doctor'), scripts)
      .allowedVerificationCommands,
    lineEndings: {
      autocrlf: autocrlf?.stdout || null,
      attributes: attributes?.stdout || null,
    },
  };
}
