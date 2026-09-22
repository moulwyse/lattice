import { z } from 'zod';
import { uid } from './core.js';
import type { TaskIR } from './types.js';

export const TaskSchema: z.ZodType<TaskIR> = z.object({
  schemaVersion: z.literal(2),
  id: z.string(),
  goal: z.string().min(1),
  constraints: z.array(z.string()),
  invariants: z.array(z.string()),
  acceptanceCriteria: z.array(z.object({ id: z.string(), text: z.string() })),
  risk: z.enum(['low', 'medium', 'high']),
  scope: z.object({ include: z.array(z.string()), exclude: z.array(z.string()) }),
  budget: z.object({
    maxTokens: z.number().positive(),
    maxPages: z.number().positive(),
    maxFaults: z.number().nonnegative(),
    maxTurns: z.number().positive(),
  }),
  allowedVerificationCommands: z.array(z.string()),
});

/**
 * Split a free-form goal into clause-level acceptance criteria. The split is
 * purely syntactic (sentences, colons, semicolons, list items and comma
 * clauses) so no task vocabulary is baked into the compiler.
 */
export function goalCriteria(goal: string) {
  const clauses = goal
    .split(/\r?\n|;|:\s|\.\s+|,\s+/)
    .map((clause) =>
      clause
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
        .replace(/^\s*(?:and|or|then)\s+/i, '')
        .replace(/[.\s]+$/, '')
        .trim(),
    )
    .filter((clause) => /[a-z0-9]{3,}/i.test(clause));
  const unique = [...new Set(clauses)];
  return unique.length > 0 ? unique : [goal.trim()];
}

const repositoryVerificationScript = /^(?:test|tests|check|lint|typecheck|type-check|build)(?::[\w:-]+)?$/;
// Watch, dev-server and UI modes never exit on their own.
const interactiveScript = /(?:^|[:-])(?:watch|dev|serve|server|start|ui|open|debug)(?:$|[:-])/;

/**
 * Extend the static allowlist with the repository's own package scripts that
 * look like verification (`test`, `test:unit`, `lint`, `typecheck`, ...).
 * Script names come from the fresh index of package.json, never from the model.
 */
export function withRepositoryVerification(task: TaskIR, scripts: Record<string, string>) {
  const commands = Object.keys(scripts)
    .filter((name) => repositoryVerificationScript.test(name) && !interactiveScript.test(name))
    .map((name) => `npm run ${name}`);
  task.allowedVerificationCommands = [
    ...new Set([...task.allowedVerificationCommands, ...commands]),
  ];
  return task;
}

export function compileTask(goal: string): TaskIR {
  const highRisk =
    /\bauth|security|password|permission|migration|concurren|crypt|payment/i.test(goal);
  const lowRisk =
    !highRisk &&
    /\b(?:fix (?:a )?typo|format(?:ting)?|sort imports|update (?:the )?(?:readme|documentation))\b/i.test(
      goal,
    );
  const criteria = goalCriteria(goal);
  return TaskSchema.parse({
    schemaVersion: 2,
    id: uid(),
    goal: goal.trim(),
    constraints: [],
    invariants: goal.match(/do not [^.;]+|preserve [^.;]+/gi) || [],
    acceptanceCriteria: criteria.map((text, index) => ({
      id: `ac-${index + 1}`,
      text,
    })),
    risk: highRisk ? 'high' : lowRisk ? 'low' : 'medium',
    scope: { include: [], exclude: [] },
    budget: { maxTokens: 12_000, maxPages: 20, maxFaults: 3, maxTurns: 4 },
    allowedVerificationCommands: [
      'npm test',
      'npm run test',
      'npm run build',
      'npm run lint',
      'npx tsc --noEmit',
      'npx vitest run',
    ],
  });
}
