import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { nativeTargetFromIntegration } from './codex-integration.js';
import type { NativeCodexTarget } from './codex-launcher.js';

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexRateLimitSnapshot = {
  limitId: string | null;
  planType: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
};

export type EvalBudgetWindow = {
  name: 'primary' | 'secondary';
  baselineUsedPercent: number;
  hardCeilingPercent: number;
  startCeilingPercent: number;
  resetsAt: number | null;
};

export type EvalBudgetPlan = {
  schemaVersion: 1;
  createdAt: string;
  limitId: string | null;
  planType: string | null;
  maxAdditionalUsedPercent: 10;
  reservePercent: 2;
  windows: EvalBudgetWindow[];
};

type AppServerRateLimitResponse = {
  rateLimits?: unknown;
  rateLimitsByLimitId?: Record<string, unknown> | null;
};

function percent(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) {
    throw new Error(`${label} must be an integer from 0 through 100`);
  }
  return Number(value);
}

function nullableInteger(value: unknown, label: string) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer or null`);
  return Number(value);
}

function parseWindow(value: unknown, label: string): RateLimitWindow | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object or null`);
  }
  const candidate = value as Record<string, unknown>;
  return {
    usedPercent: percent(candidate.usedPercent, `${label}.usedPercent`),
    windowDurationMins: nullableInteger(
      candidate.windowDurationMins,
      `${label}.windowDurationMins`,
    ),
    resetsAt: nullableInteger(candidate.resetsAt, `${label}.resetsAt`),
  };
}

export function parseCodexRateLimitResponse(
  value: unknown,
): CodexRateLimitSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex rate-limit response must be an object');
  }
  const response = value as AppServerRateLimitResponse;
  const byId = response.rateLimitsByLimitId;
  const selected =
    byId && typeof byId === 'object' && !Array.isArray(byId) && byId.codex
      ? byId.codex
      : response.rateLimits;
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    throw new Error('Codex rate-limit response has no usable snapshot');
  }
  const snapshot = selected as Record<string, unknown>;
  const limitId = snapshot.limitId;
  const planType = snapshot.planType;
  return {
    limitId: typeof limitId === 'string' ? limitId : null,
    planType: typeof planType === 'string' ? planType : null,
    primary: parseWindow(snapshot.primary, 'primary'),
    secondary: parseWindow(snapshot.secondary, 'secondary'),
  };
}

export function createTenPercentBudget(
  snapshot: CodexRateLimitSnapshot,
): EvalBudgetPlan {
  const windows = (['primary', 'secondary'] as const)
    .flatMap((name) => {
      const window = snapshot[name];
      if (!window) return [];
      const hardCeilingPercent = Math.min(100, window.usedPercent + 10);
      return [{
        name,
        baselineUsedPercent: window.usedPercent,
        hardCeilingPercent,
        startCeilingPercent: Math.max(
          window.usedPercent,
          hardCeilingPercent - 2,
        ),
        resetsAt: window.resetsAt,
      }];
    });
  if (windows.length === 0) {
    throw new Error('Codex did not expose a rate-limit window; live eval stays disabled');
  }
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    limitId: snapshot.limitId,
    planType: snapshot.planType,
    maxAdditionalUsedPercent: 10,
    reservePercent: 2,
    windows,
  };
}

export function evaluateTenPercentBudget(
  plan: EvalBudgetPlan,
  snapshot: CodexRateLimitSnapshot,
) {
  const reasons: string[] = [];
  const windows = plan.windows.map((budget) => {
    const current = snapshot[budget.name];
    if (!current) {
      reasons.push(`${budget.name} rate-limit window disappeared`);
      return {
        ...budget,
        currentUsedPercent: null,
        consumedPercent: null,
        remainingPercent: null,
        canStart: false,
        withinHardCeiling: false,
      };
    }
    if (current.resetsAt !== budget.resetsAt) {
      reasons.push(`${budget.name} rate-limit window changed or reset`);
    }
    if (current.usedPercent < budget.baselineUsedPercent) {
      reasons.push(`${budget.name} usage moved below its captured baseline`);
    }
    const consumedPercent = current.usedPercent - budget.baselineUsedPercent;
    const remainingPercent = budget.hardCeilingPercent - current.usedPercent;
    const withinHardCeiling = current.usedPercent <= budget.hardCeilingPercent;
    const stableWindow =
      current.resetsAt === budget.resetsAt &&
      current.usedPercent >= budget.baselineUsedPercent;
    const canStart =
      stableWindow &&
      withinHardCeiling &&
      current.usedPercent < budget.startCeilingPercent;
    if (!withinHardCeiling) reasons.push(`${budget.name} exceeded the 10% hard ceiling`);
    if (stableWindow && current.usedPercent >= budget.startCeilingPercent) {
      reasons.push(`${budget.name} reached the reserved stop-before-start ceiling`);
    }
    return {
      ...budget,
      currentUsedPercent: current.usedPercent,
      consumedPercent,
      remainingPercent,
      canStart,
      withinHardCeiling,
    };
  });
  return {
    schemaVersion: 1 as const,
    checkedAt: new Date().toISOString(),
    canStartLiveTurn: reasons.length === 0 && windows.every((window) => window.canStart),
    withinHardCeiling: windows.every((window) => window.withinHardCeiling),
    reasons,
    windows,
  };
}

export async function readCodexRateLimits(
  options: { target?: NativeCodexTarget; timeoutMs?: number } = {},
) {
  const target = options.target ?? nativeTargetFromIntegration();
  const child = spawn(
    target.command,
    [...target.prefixArguments, 'app-server', '--stdio'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let nextId = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const request = (method: string, params: unknown) => {
    const id = nextId;
    nextId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  };
  const timeout = setTimeout(() => {
    const error = new Error(`Codex rate-limit read timed out: ${stderr.trim()}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    child.kill();
  }, options.timeoutMs ?? 15_000);
  try {
    await request('initialize', {
      clientInfo: { name: 'lattice-eval-budget', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const response = await request('account/rateLimits/read', null);
    return parseCodexRateLimitResponse(response);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
