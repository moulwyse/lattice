import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import { readCodexSessionModelState } from './codex-session-sync.js';
import type { Risk } from './types.js';

export const reasoningEfforts = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly ModelReasoningEffort[];

export type CodexModelOverrides = {
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  modelPolicy?: ModelPolicy;
};

export type ModelPolicy = 'inherit' | 'adaptive';

export type ResolvedCodexModelSettings = CodexModelOverrides & {
  modelSource:
    | 'cli'
    | 'lattice-config'
    | 'codex-session'
    | 'adaptive-policy'
    | 'codex-config';
  reasoningEffortSource:
    | 'cli'
    | 'lattice-config'
    | 'codex-session'
    | 'adaptive-policy'
    | 'codex-config';
  modelPolicy: ModelPolicy;
  modelPolicySource: 'cli' | 'lattice-config' | 'default';
  policyRisk: Risk;
};

type LatticeModelConfig = {
  model?: unknown;
  reasoningEffort?: unknown;
  modelPolicy?: unknown;
};

function configuredValue(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined || value === 'inherit') return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string or "inherit"`);
  }
  return value.trim();
}

export function parseReasoningEffort(
  value: string | undefined,
): ModelReasoningEffort | undefined {
  if (value === undefined || value === 'inherit') return undefined;
  if (!reasoningEfforts.includes(value as ModelReasoningEffort)) {
    throw new Error(
      `reasoning effort must be one of: ${reasoningEfforts.join(', ')}, or inherit`,
    );
  }
  return value as ModelReasoningEffort;
}

export function parseModelPolicy(value: unknown, label = 'model policy'): ModelPolicy {
  if (value === undefined) return 'inherit';
  if (value !== 'inherit' && value !== 'adaptive') {
    throw new Error(`${label} must be one of: inherit, adaptive`);
  }
  return value;
}

function loadLatticeModelConfig(workspace: string): LatticeModelConfig {
  const path = join(workspace, 'lattice.config.json');
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `invalid lattice.config.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lattice.config.json must contain a JSON object');
  }
  return value as LatticeModelConfig;
}

export function resolveCodexModelSettings(
  workspace: string,
  overrides: { model?: string; reasoningEffort?: string; modelPolicy?: string } = {},
  risk: Risk = 'medium',
): ResolvedCodexModelSettings {
  const config = loadLatticeModelConfig(workspace);
  const codexSession = readCodexSessionModelState(workspace);
  const cliModel = configuredValue(overrides.model, '--model');
  const configModel = configuredValue(config.model, 'lattice.config.json model');
  const cliReasoning = parseReasoningEffort(overrides.reasoningEffort);
  const configReasoning = parseReasoningEffort(
    configuredValue(
      config.reasoningEffort,
      'lattice.config.json reasoningEffort',
    ),
  );
  const cliPolicy = overrides.modelPolicy
    ? parseModelPolicy(overrides.modelPolicy, '--model-policy')
    : undefined;
  const configPolicy =
    config.modelPolicy === undefined
      ? undefined
      : parseModelPolicy(config.modelPolicy, 'lattice.config.json modelPolicy');
  const modelPolicy = cliPolicy ?? configPolicy ?? 'inherit';
  const adaptiveModel =
    modelPolicy === 'adaptive'
      ? risk === 'low'
        ? 'gpt-5.6-luna'
        : risk === 'medium'
          ? 'gpt-5.6-terra'
          : undefined
      : undefined;
  const adaptiveReasoning =
    modelPolicy === 'adaptive'
      ? risk === 'low'
        ? ('low' as const)
        : risk === 'medium'
          ? ('medium' as const)
          : undefined
      : undefined;
  const sessionModel = codexSession?.model;
  const sessionReasoning = codexSession?.reasoningEffort ?? undefined;
  const model = cliModel ?? configModel ?? sessionModel ?? adaptiveModel;
  // Current Codex hooks expose the exact active model; session sync supplements
  // it with the matching bounded rollout effort when available. Once a live
  // session is observed, inheritance is safer than an adaptive substitution.
  const reasoningEffort =
    cliReasoning ??
    configReasoning ??
    sessionReasoning ??
    (codexSession ? undefined : adaptiveReasoning);
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    modelPolicy,
    modelPolicySource: cliPolicy
      ? 'cli'
      : configPolicy
        ? 'lattice-config'
        : 'default',
    policyRisk: risk,
    modelSource: cliModel
      ? 'cli'
      : configModel
        ? 'lattice-config'
        : sessionModel
          ? 'codex-session'
        : adaptiveModel
            ? 'adaptive-policy'
            : 'codex-config',
    reasoningEffortSource: cliReasoning
      ? 'cli'
      : configReasoning
        ? 'lattice-config'
        : sessionReasoning
          ? 'codex-session'
          : codexSession
            ? 'codex-config'
            : adaptiveReasoning
              ? 'adaptive-policy'
              : 'codex-config',
  };
}
