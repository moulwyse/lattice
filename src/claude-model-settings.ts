import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeEffortSchema,
  readClaudeSessionModelState,
} from './claude-session-sync.js';
import { parseModelPolicy, type ModelPolicy } from './model-settings.js';
import type { Risk } from './types.js';

export const CLAUDE_OPUS_5_MODEL = 'claude-opus-5';
export const CLAUDE_SONNET_5_MODEL = 'claude-sonnet-5';
export const CLAUDE_HAIKU_4_5_MODEL = 'claude-haiku-4-5';

export type ClaudeReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type ClaudeModelOverrides = {
  model?: string;
  reasoningEffort?: ClaudeReasoningEffort;
  modelPolicy?: ModelPolicy;
  maxBudgetUsd?: number;
};

export type ResolvedClaudeModelSettings = ClaudeModelOverrides & {
  modelSource:
    | 'cli'
    | 'lattice-config'
    | 'claude-session'
    | 'adaptive-policy'
    | 'claude-default';
  reasoningEffortSource:
    | 'cli'
    | 'lattice-config'
    | 'claude-session'
    | 'adaptive-policy'
    | 'claude-default';
  modelPolicy: ModelPolicy;
  modelPolicySource: 'cli' | 'lattice-config' | 'default';
  policyRisk: Risk;
};

type LatticeModelConfig = {
  model?: unknown;
  reasoningEffort?: unknown;
  modelPolicy?: unknown;
  providers?: {
    claude?: {
      model?: unknown;
      reasoningEffort?: unknown;
      modelPolicy?: unknown;
      maxBudgetUsd?: unknown;
    };
  };
};

function configuredValue(value: unknown, label: string) {
  if (value === undefined || value === 'inherit') return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string or "inherit"`);
  }
  return value.trim();
}

function configuredBudget(value: unknown, label: string) {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return parsed;
}

export function parseClaudeReasoningEffort(
  value: string | undefined,
): ClaudeReasoningEffort | undefined {
  if (value === undefined || value === 'inherit') return undefined;
  const parsed = ClaudeEffortSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'Claude reasoning effort must be one of: low, medium, high, xhigh, max, or inherit',
    );
  }
  return parsed.data;
}

function loadLatticeModelConfig(workspace: string): LatticeModelConfig {
  const path = join(workspace, 'lattice.config.json');
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lattice.config.json must contain a JSON object');
  }
  return value as LatticeModelConfig;
}

export function resolveClaudeModelSettings(
  workspace: string,
  overrides: {
    model?: string;
    reasoningEffort?: string;
    modelPolicy?: string;
    maxBudgetUsd?: number;
  } = {},
  risk: Risk = 'medium',
): ResolvedClaudeModelSettings {
  const config = loadLatticeModelConfig(workspace);
  const providerConfig = config.providers?.claude ?? {};
  const session = readClaudeSessionModelState(workspace);
  const cliModel = configuredValue(overrides.model, '--model');
  const configModel = configuredValue(
    providerConfig.model ?? config.model,
    'Claude model in lattice.config.json',
  );
  const cliReasoning = parseClaudeReasoningEffort(overrides.reasoningEffort);
  const configReasoning = parseClaudeReasoningEffort(
    configuredValue(
      providerConfig.reasoningEffort ?? config.reasoningEffort,
      'Claude reasoningEffort in lattice.config.json',
    ),
  );
  const maxBudgetUsd = configuredBudget(
    overrides.maxBudgetUsd ?? providerConfig.maxBudgetUsd,
    'Claude maxBudgetUsd',
  );
  const cliPolicy = overrides.modelPolicy
    ? parseModelPolicy(overrides.modelPolicy, '--model-policy')
    : undefined;
  const configuredPolicy =
    providerConfig.modelPolicy ?? config.modelPolicy;
  const configPolicy =
    configuredPolicy === undefined
      ? undefined
      : parseModelPolicy(configuredPolicy, 'Claude modelPolicy in lattice.config.json');
  const modelPolicy = cliPolicy ?? configPolicy ?? 'inherit';
  const adaptive =
    modelPolicy === 'adaptive'
      ? risk === 'low'
        ? { model: CLAUDE_HAIKU_4_5_MODEL }
        : risk === 'medium'
          ? {
              model: CLAUDE_SONNET_5_MODEL,
              reasoningEffort: 'medium' as const,
            }
          : {
              model: CLAUDE_OPUS_5_MODEL,
              reasoningEffort: 'xhigh' as const,
            }
      : {};
  const model =
    cliModel ?? configModel ?? session?.model ?? adaptive.model;
  const reasoningEffort =
    cliReasoning ??
    configReasoning ??
    session?.reasoningEffort ??
    adaptive.reasoningEffort;

  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
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
        : session?.model
          ? 'claude-session'
          : adaptive.model
            ? 'adaptive-policy'
            : 'claude-default',
    reasoningEffortSource: cliReasoning
      ? 'cli'
      : configReasoning
        ? 'lattice-config'
        : session?.reasoningEffort
          ? 'claude-session'
          : adaptive.reasoningEffort
            ? 'adaptive-policy'
            : 'claude-default',
  };
}

