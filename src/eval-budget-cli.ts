import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { metadata, readJson, writeJson } from './core.js';
import {
  createTenPercentBudget,
  evaluateTenPercentBudget,
  readCodexRateLimits,
  type EvalBudgetPlan,
} from './eval-budget.js';

const command = process.argv[2] ?? 'status';
const workspace = process.cwd();
const planPath = join(metadata(workspace), 'benchmarks', 'live-eval-budget.json');
const snapshot = await readCodexRateLimits();

if (command === 'snapshot') {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, snapshot }, null, 2)}\n`);
} else if (command === 'init') {
  const existing = existsSync(planPath)
    ? readJson<EvalBudgetPlan>(planPath)
    : null;
  const sameWindow = existing?.windows.every(
    (window) => snapshot[window.name]?.resetsAt === window.resetsAt,
  ) ?? false;
  const plan = sameWindow ? existing! : createTenPercentBudget(snapshot);
  if (!sameWindow) writeJson(planPath, plan);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, planPath, snapshot, plan, reused: sameWindow }, null, 2)}\n`,
  );
} else if (command === 'status' || command === 'guard') {
  const plan = readJson<EvalBudgetPlan>(planPath);
  const assessment = evaluateTenPercentBudget(plan, snapshot);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, planPath, snapshot, plan, assessment }, null, 2)}\n`,
  );
  if (command === 'guard' && !assessment.canStartLiveTurn) process.exitCode = 3;
} else {
  throw new Error('usage: eval-budget-cli [snapshot|init|status|guard]');
}
