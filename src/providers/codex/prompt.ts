import { rawHash } from '../../core.js';
import { providerContextPage } from '../../edit-grants.js';
import type {
  ContextPage,
  EditGrantRegistryIR,
  PromptManifest,
  TaskIR,
  Telemetry,
  TurnKind,
} from '../../types.js';

type PromptInput = {
  task: TaskIR;
  repositoryMap: { path: string; symbols: string[] }[];
  metrics: Telemetry;
  editGrants: EditGrantRegistryIR;
};

export const externalProtocol = {
  oneOf: [
    {
      kind: 'context_request',
      requests: [
        {
          reason: 'why this information is required',
          pathHint: 'optional/repository/relative/path',
          symbol: 'optional symbol',
        },
      ],
    },
    {
      kind: 'patch',
      patch: {
        summary: 'short description',
        changes: [
          {
            editHandle: 'E1',
            operation: 'replace_text',
            replacements: [
              {
                oldContent: 'exact unique granted text',
                newContent: 'replacement text',
              },
            ],
          },
        ],
        verificationCommands: ['npm test'],
      },
    },
  ],
};

const protocolText = JSON.stringify(externalProtocol);
const systemInstructions = [
  'You are the Lattice repository worker.',
  'Return pure JSON only, without Markdown or explanatory prose.',
  'Return exactly one top-level action with kind context_request or patch.',
  'Patch changes must use only granted editHandle values.',
  'Patch responses must never return a path, fingerprint, repository identity, base commit, or transaction metadata.',
  'Prefer replace_text for localized edits: oldContent must be exact, non-empty, and unique in the granted file.',
  'Use replace_file only when the complete file was granted and a broad rewrite is necessary.',
  'Do not change files that were not granted as context.',
].join('\n');

export const STABLE_WORKER_PREFIX = [
  'LATTICE_WORKER_PROTOCOL_V4',
  systemInstructions,
  'CANONICAL_OUTPUT_PROTOCOL',
  protocolText,
].join('\n');

export const STABLE_WORKER_PREFIX_SHA256 = rawHash(
  Buffer.from(STABLE_WORKER_PREFIX, 'utf8'),
);

type BuiltPrompt = { text: string; manifest: PromptManifest };

function manifest(
  turnNumber: number,
  kind: TurnKind,
  components: {
    stablePrefixCharacters: number;
    taskCharacters: number;
    repositoryMapCharacters: number;
    contextCharacters: number;
    protocolCharacters: number;
    continuationCharacters: number;
  },
): PromptManifest {
  return {
    turnNumber,
    kind,
    ...components,
    historyCharacters: null,
    stablePrefixSha256: STABLE_WORKER_PREFIX_SHA256,
  };
}

function providerTask(task: TaskIR) {
  const projected: Record<string, unknown> = {
    goal: task.goal,
    acceptanceCriteria: task.acceptanceCriteria.map((criterion) => criterion.text),
    risk: task.risk,
    allowedVerificationCommands: task.allowedVerificationCommands,
  };
  if (task.constraints.length > 0) projected.constraints = task.constraints;
  if (task.invariants.length > 0) projected.invariants = task.invariants;
  if (task.scope.include.length > 0 || task.scope.exclude.length > 0) {
    projected.scope = task.scope;
  }
  return projected;
}

function providerRepositoryMap(
  repositoryMap: PromptInput['repositoryMap'],
  pages: ContextPage[],
) {
  const grantedPaths = new Set(pages.map((page) => page.path));
  return repositoryMap
    .filter((entry) => !grantedPaths.has(entry.path))
    .map((entry) => [entry.path, [...new Set(entry.symbols)]]);
}

function providerPromptContext(
  registry: EditGrantRegistryIR,
  pages: ContextPage[],
) {
  return pages.map((page) => {
    const projected = providerContextPage(registry, page);
    return {
      editHandle: projected.editHandle,
      path: projected.path,
      ...(projected.symbol ? { symbol: projected.symbol } : {}),
      ...(projected.complete
        ? {}
        : { startLine: projected.startLine, endLine: projected.endLine }),
      permissions: projected.permissions,
      content: projected.content,
    };
  });
}

export function buildInitialWorkerPrompt(
  input: PromptInput,
  pages: ContextPage[],
): BuiltPrompt {
  const task = JSON.stringify(providerTask(input.task));
  const repositoryMap = JSON.stringify(
    providerRepositoryMap(input.repositoryMap, pages),
  );
  const context = JSON.stringify(providerPromptContext(input.editGrants, pages));
  const text = [
    STABLE_WORKER_PREFIX,
    'DYNAMIC_TASK',
    task,
    'DYNAMIC_UNGRANTED_REPOSITORY_MAP_ROWS_[path,symbols]',
    repositoryMap,
    'DYNAMIC_GRANTED_CONTEXT',
    context,
  ].join('\n');
  return {
    text,
    manifest: manifest(input.metrics.turnUsage.length + 1, 'initial', {
      stablePrefixCharacters: STABLE_WORKER_PREFIX.length,
      taskCharacters: task.length,
      repositoryMapCharacters: repositoryMap.length,
      contextCharacters: context.length,
      protocolCharacters: protocolText.length,
      continuationCharacters: 0,
    }),
  };
}

export function buildContextFaultPrompt(
  metrics: Telemetry,
  newlyGrantedPages: ContextPage[],
  registry: EditGrantRegistryIR,
): BuiltPrompt {
  const instruction =
    'Continue with these newly granted pages; return one canonical JSON action.';
  const context = JSON.stringify(providerPromptContext(registry, newlyGrantedPages));
  const text = `${instruction}\n${context}`;
  return {
    text,
    manifest: manifest(metrics.turnUsage.length + 1, 'context_fault', {
      stablePrefixCharacters: 0,
      taskCharacters: 0,
      repositoryMapCharacters: 0,
      contextCharacters: context.length,
      protocolCharacters: 0,
      continuationCharacters: instruction.length,
    }),
  };
}

export function buildProtocolRepairPrompt(
  metrics: Telemetry,
  error: string,
): BuiltPrompt {
  const repair = JSON.stringify({
    validationError: error,
    expected: 'top-level kind is context_request or patch',
    instruction:
      'Return one corrected canonical JSON action. Never combine actions; use granted handles and permitted operations only.',
  });
  const heading = 'PROTOCOL_REPAIR';
  return {
    text: `${heading}\n${repair}`,
    manifest: manifest(metrics.turnUsage.length + 1, 'protocol_repair', {
      stablePrefixCharacters: 0,
      taskCharacters: 0,
      repositoryMapCharacters: 0,
      contextCharacters: 0,
      protocolCharacters: 0,
      continuationCharacters: heading.length + 1 + repair.length,
    }),
  };
}
