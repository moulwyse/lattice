import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { safePath } from '../src/core.js';
import {
  createTenPercentBudget,
  evaluateTenPercentBudget,
  type CodexRateLimitSnapshot,
} from '../src/eval-budget.js';
import { editGrantMappingDigest } from '../src/edit-grants.js';
import {
  lowerProviderPatch,
  PatchLoweringError,
} from '../src/patch-lowerer.js';
import {
  parseResponse,
  WorkerProtocolError,
} from '../src/providers/codex/protocol.js';
import { compileTask } from '../src/task.js';
import { telemetry } from '../src/telemetry.js';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import type {
  EditGrantRegistryIR,
  ProviderPatchIR,
} from '../src/types.js';

const highTerms = [
  'auth',
  'security',
  'password',
  'permission',
  'migration',
  'concurrency',
  'cryptography',
  'payment',
];
const lowPhrases = [
  'fix typo',
  'fix a typo',
  'format',
  'formatting',
  'sort imports',
  'update readme',
  'update documentation',
  'update the README',
];
const mediumPhrases = [
  'optimize list rendering',
  'add pagination',
  'repair cache invalidation',
  'rename the public method',
  'improve parser recovery',
  'add export support',
  'fix request batching',
  'preserve configuration behavior',
];
const riskCases = [
  ...highTerms.flatMap((term) => [
    { goal: `Fix ${term} boundary behavior`, expected: 'high' as const },
    { goal: `PLEASE REPAIR ${term.toUpperCase()} LOGIC`, expected: 'high' as const },
  ]),
  ...lowPhrases.flatMap((phrase) => [
    { goal: phrase, expected: 'low' as const },
    { goal: `Please ${phrase.toUpperCase()} cleanly`, expected: 'low' as const },
  ]),
  ...mediumPhrases.flatMap((phrase) => [
    { goal: phrase, expected: 'medium' as const },
    { goal: `Please ${phrase.toUpperCase()} without regressions`, expected: 'medium' as const },
  ]),
];

describe('economy frontier: task risk never silently downgrades', () => {
  test.each(riskCases)('$expected: $goal', ({ goal, expected }) => {
    const task = compileTask(goal);
    expect(task.risk).toBe(expected);
    expect(task.budget).toEqual({
      maxTokens: 12_000,
      maxPages: 20,
      maxFaults: 3,
      maxTurns: 4,
    });
  });
});

function patchWire(index: number) {
  return {
    kind: 'patch',
    patch: {
      summary: `frontier patch ${index}`,
      changes: [
        {
          editHandle: `E${index + 1}`,
          operation: 'replace_text',
          replacements: [
            { oldContent: `old-${index}`, newContent: `new-${index}` },
          ],
        },
      ],
      verificationCommands: ['npm test'],
    },
  };
}

const protocolCases = [
  ...Array.from({ length: 12 }, (_, index) => ({
    name: `valid context request ${index}`,
    raw: JSON.stringify({
      kind: 'context_request',
      requests: [{ reason: `need dependency ${index}`, pathHint: `src/module-${index}.ts` }],
    }),
    accepted: true,
    kind: 'context_request' as const,
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    name: `valid exact patch ${index}`,
    raw: JSON.stringify(patchWire(index)),
    accepted: true,
    kind: 'patch' as const,
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    name: `ambiguous combined action ${index}`,
    raw: JSON.stringify({
      contextRequest: {
        kind: 'context_request',
        requests: [{ reason: `ambiguous ${index}`, symbol: `Symbol${index}` }],
      },
      patch: patchWire(index),
    }),
    accepted: false,
    kind: null,
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    name: `malformed JSON ${index}`,
    raw: `{"kind":"patch","variant":${index}`,
    accepted: false,
    kind: null,
  })),
];

describe('economy frontier: provider protocol remains fail-closed', () => {
  test.each(protocolCases)('$name', ({ raw, accepted, kind }) => {
    if (accepted) {
      expect(parseResponse(raw).kind).toBe(kind);
    } else {
      expect(() => parseResponse(raw)).toThrow(WorkerProtocolError);
    }
  });
});

const pathRoot = join(tmpdir(), 'lattice-frontier-safe-root');
const pathCases = [
  ...Array.from({ length: 24 }, (_, index) => ({
    name: `safe nested path ${index}`,
    path: `src/feature-${index}/file ${index}.ts`,
    accepted: true,
  })),
  ...Array.from({ length: 8 }, (_, index) => ({
    name: `parent traversal ${index}`,
    path: `../secret-${index}.txt`,
    accepted: false,
  })),
  ...Array.from({ length: 8 }, (_, index) => ({
    name: `nested traversal ${index}`,
    path: `src/feature-${index}/../../secret.txt`,
    accepted: false,
  })),
  ...Array.from({ length: 8 }, (_, index) => ({
    name: `absolute path ${index}`,
    path: join(pathRoot, 'absolute', `secret-${index}.txt`),
    accepted: false,
  })),
];

describe('economy frontier: repository path confinement', () => {
  test.each(pathCases)('$name', ({ path, accepted }) => {
    if (accepted) {
      expect(safePath(pathRoot, path)).toContain(pathRoot);
    } else {
      expect(() => safePath(pathRoot, path)).toThrow(/unsafe|outside/);
    }
  });
});

let patchWorkspace: string;
let patchRegistry: EditGrantRegistryIR;
const patchIdentity = {
  taskId: 'frontier-task',
  sessionId: 'frontier-session',
  repositoryId: 'repo:frontier',
  baseCommit: 'frontier-base',
  epoch: 1,
};

beforeAll(() => {
  patchWorkspace = mkdtempSync(join(tmpdir(), 'lattice-frontier-patch-'));
  mkdirSync(join(patchWorkspace, 'src'), { recursive: true });
  const content = [
    ...Array.from({ length: 24 }, (_, index) => `const frontier_${index} = ${index};`),
    'const duplicate_marker = true;',
    'const duplicate_marker = true;',
    '',
  ].join('\n');
  writeFileSync(join(patchWorkspace, 'src', 'frontier.js'), content, 'utf8');
  const registryWithoutDigest: Omit<EditGrantRegistryIR, 'mappingSha256'> = {
    schemaVersion: 1,
    ...patchIdentity,
    nextHandle: 2,
    grants: [
      {
        schemaVersion: 1,
        handle: 'E1',
        ...patchIdentity,
        path: 'src/frontier.js',
        fingerprint: 'git:frontier',
        permissions: ['replace_text'],
        contextPageId: 'file:frontier',
        invalidated: false,
        startLine: 1,
        endLine: 27,
        complete: true,
      },
    ],
  };
  patchRegistry = {
    ...registryWithoutDigest,
    mappingSha256: editGrantMappingDigest(registryWithoutDigest),
  };
});

afterAll(async () => {
  await removeDirectoryWithRetry(patchWorkspace);
});

const loweringCases = [
  ...Array.from({ length: 24 }, (_, index) => ({
    name: `unique exact replacement ${index}`,
    oldContent: `const frontier_${index} = ${index};`,
    newContent: `const frontier_${index} = ${index + 100};`,
    accepted: true,
    reason: null,
  })),
  ...Array.from({ length: 24 }, (_, index) => ({
    name: index % 2 === 0
      ? `ambiguous exact replacement ${index}`
      : `missing exact replacement ${index}`,
    oldContent: index % 2 === 0
      ? 'const duplicate_marker = true;'
      : `const absent_${index} = true;`,
    newContent: `const rejected_${index} = false;`,
    accepted: false,
    reason: index % 2 === 0
      ? 'replacement_source_ambiguous'
      : 'replacement_outside_grant',
  })),
];

describe('economy frontier: exact patch lowering', () => {
  test.each(loweringCases)('$name', ({ oldContent, newContent, accepted, reason }) => {
    const providerPatch: ProviderPatchIR = {
      schemaVersion: 1,
      summary: 'frontier exact replacement',
      changes: [
        {
          editHandle: 'E1',
          operation: 'replace_text',
          replacements: [{ oldContent, newContent }],
        },
      ],
      verificationCommands: ['npm test'],
    };
    if (accepted) {
      const lowered = lowerProviderPatch(
        providerPatch,
        patchRegistry,
        patchIdentity,
        telemetry(),
        patchWorkspace,
      );
      expect(lowered.changes[0].replacementContent).toContain(newContent);
    } else {
      try {
        lowerProviderPatch(
          providerPatch,
          patchRegistry,
          patchIdentity,
          telemetry(),
          patchWorkspace,
        );
        throw new Error('expected lowering to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(PatchLoweringError);
        expect((error as PatchLoweringError).reason).toBe(reason);
      }
    }
  });
});

const budgetCases = Array.from({ length: 48 }, (_, index) => {
  const group = Math.floor(index / 12);
  const baseline = (index % 12) * 4;
  const increase = [0, 7, 8, 11][group];
  return {
    name: `baseline ${baseline}, increase ${increase}`,
    baseline,
    current: baseline + increase,
    canStart: group < 2,
    withinHardCeiling: group < 3,
  };
});

function rateSnapshot(usedPercent: number, resetsAt = 2_000_000_000): CodexRateLimitSnapshot {
  return {
    limitId: 'codex',
    planType: 'plus',
    primary: {
      usedPercent,
      windowDurationMins: 10_080,
      resetsAt,
    },
    secondary: null,
  };
}

describe('economy frontier: ten-percent live budget is fail-closed', () => {
  test.each(budgetCases)(
    '$name',
    ({ baseline, current, canStart, withinHardCeiling }) => {
      const plan = createTenPercentBudget(rateSnapshot(baseline));
      const assessment = evaluateTenPercentBudget(plan, rateSnapshot(current));
      expect(assessment.canStartLiveTurn).toBe(canStart);
      expect(assessment.withinHardCeiling).toBe(withinHardCeiling);
      expect(plan.maxAdditionalUsedPercent).toBe(10);
      expect(plan.reservePercent).toBe(2);
    },
  );
});
