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

export function compileTask(goal: string): TaskIR {
  const reset = /reset token|password.reset/i.test(goal);
  const highRisk = /auth|security|password|permission|migration|concurren|crypt|payment/i.test(
    goal,
  );
  const lowRisk =
    !highRisk &&
    /\b(?:fix (?:a )?typo|format(?:ting)?|sort imports|update (?:the )?(?:readme|documentation))\b/i.test(
      goal,
    );
  const criteria = reset
    ? [
        'reset token is consumed once',
        'second consumption returns undefined',
        'expired token remains rejected',
        'successful reset records audit event',
        'login behavior remains unchanged',
      ]
    : [goal.trim()];
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
