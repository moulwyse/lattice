import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContextKernel } from '../src/context.js';
import {
  createEditGrantRegistry,
  editGrantMappingDigest,
  grantForPage,
  loadEditGrantRegistry,
  persistEditGrantRegistry,
  syncEditGrantRegistry,
} from '../src/edit-grants.js';
import { buildIndex } from '../src/indexer.js';
import { lowerProviderPatch, PatchLoweringError } from '../src/patch-lowerer.js';
import { RuntimeStateMachine } from '../src/state-machine.js';
import { compileTask } from '../src/task.js';
import { telemetry } from '../src/telemetry.js';
import { transact } from '../src/transaction.js';
import type {
  ContextPage,
  EditGrantRegistryIR,
  ProviderPatchIR,
} from '../src/types.js';
import { repository, type TestRepository } from './helpers.js';

let repo: TestRepository;

beforeAll(async () => {
  repo = await repository({
    'package.json': JSON.stringify({
      private: true,
      scripts: { test: 'node --test tests/*.test.js' },
    }),
    'tests/value.test.js':
      "require('../src/value.js');\nconst test = require('node:test');\ntest('value behavior', () => {});\n",
    'src/value.js': 'module.exports = 1;\n',
    'src/auxiliary.js': 'module.exports = 2;\n',
  });
}, 30_000);

afterAll(() => repo.cleanup());

async function setup() {
  const task = compileTask('Fix value behavior');
  const sessionId = `session-${task.id}`;
  const index = await buildIndex(repo.path);
  const kernel = new ContextKernel(repo.path, index, task);
  const pages = kernel.initial();
  const registry = await createEditGrantRegistry(
    repo.path,
    task.id,
    sessionId,
    pages,
  );
  const editablePage = pages.find((page) => page.path === 'src/value.js')!;
  const readOnlyPage = pages.find((page) => page.path === 'tests/value.test.js')!;
  const editableGrant = grantForPage(registry, editablePage)!;
  const readOnlyGrant = grantForPage(registry, readOnlyPage)!;
  const identity = {
    taskId: task.id,
    sessionId,
    repositoryId: registry.repositoryId,
    baseCommit: registry.baseCommit,
    epoch: registry.epoch,
  };
  const patch: ProviderPatchIR = {
    schemaVersion: 1,
    summary: 'Replace value',
    changes: [
      {
        editHandle: editableGrant.handle,
        operation: 'replace_file',
        replacementContent: 'module.exports = 2;\n',
      },
    ],
    verificationCommands: ['npm test'],
  };
  return {
    task,
    sessionId,
    index,
    kernel,
    pages,
    registry,
    editablePage,
    readOnlyPage,
    editableGrant,
    readOnlyGrant,
    identity,
    patch,
  };
}

function cloneRegistry(registry: EditGrantRegistryIR) {
  return structuredClone(registry);
}

describe('Edit Grant Registry and PatchLowerer', () => {
  it('lowers a valid handle to the exact trusted path and fingerprint', async () => {
    const value = await setup();
    const metrics = telemetry();
    const internal = lowerProviderPatch(
      value.patch,
      value.registry,
      value.identity,
      metrics,
    );
    expect(internal).toMatchObject({
      schemaVersion: 1,
      repositoryId: value.registry.repositoryId,
      baseCommit: value.registry.baseCommit,
      changes: [
        {
          path: value.editablePage.path,
          expectedFingerprint: value.editablePage.fingerprint.value,
          operation: 'modify',
        },
      ],
    });
    expect(JSON.stringify(value.patch)).not.toContain(value.editablePage.fingerprint.value);
    expect(metrics.resolvedEditGrantCount).toBe(1);
  });

  it('lowers an exact unique text replacement inside granted context', async () => {
    const value = await setup();
    const metrics = telemetry();
    value.patch.changes = [
      {
        editHandle: value.editableGrant.handle,
        operation: 'replace_text',
        replacements: [
          { oldContent: 'module.exports = 1;', newContent: 'module.exports = 2;' },
        ],
      },
    ];
    const internal = lowerProviderPatch(
      value.patch,
      value.registry,
      value.identity,
      metrics,
      repo.path,
    );
    expect(internal.changes[0].replacementContent).toBe('module.exports = 2;\n');
    expect(internal.changes[0].expectedFingerprint).toBe(
      value.editablePage.fingerprint.value,
    );
  });

  it('rejects exact-text replacement content outside the granted slice', async () => {
    const value = await setup();
    value.editableGrant.startLine = 1;
    value.editableGrant.endLine = 1;
    persistEditGrantRegistry(repo.path, value.registry);
    value.patch.changes = [
      {
        editHandle: value.editableGrant.handle,
        operation: 'replace_text',
        replacements: [{ oldContent: 'not granted', newContent: 'blocked' }],
      },
    ];
    expect(() =>
      lowerProviderPatch(
        value.patch,
        value.registry,
        value.identity,
        telemetry(),
        repo.path,
      ),
    ).toThrow(/outside granted context/);
  });

  it('rejects an unknown handle', async () => {
    const value = await setup();
    value.patch.changes[0].editHandle = 'E999';
    expect(() =>
      lowerProviderPatch(value.patch, value.registry, value.identity, telemetry()),
    ).toThrow(/unknown edit handle/);
  });

  it.each([
    ['taskId', 'another-task', 'task'],
    ['sessionId', 'another-session', 'session'],
    ['repositoryId', 'repo:another', 'repository'],
    ['baseCommit', 'another-commit', 'base commit'],
    ['epoch', 99, 'epoch'],
  ] as const)('rejects a handle with %s mismatch', async (field, replacement, message) => {
    const value = await setup();
    const identity = { ...value.identity, [field]: replacement };
    expect(() =>
      lowerProviderPatch(value.patch, value.registry, identity, telemetry()),
    ).toThrow(new RegExp(message));
  });

  it('rejects an invalidated handle and old epoch', async () => {
    const value = await setup();
    value.editableGrant.invalidated = true;
    persistEditGrantRegistry(repo.path, value.registry);
    expect(() =>
      lowerProviderPatch(value.patch, value.registry, value.identity, telemetry()),
    ).toThrow(/invalidated/);
  });

  it.each(['path', 'expectedFingerprint', 'fingerprint'])(
    'rejects model-supplied %s alongside a handle',
    async (field) => {
      const value = await setup();
      Object.assign(value.patch.changes[0], { [field]: 'provider-controlled' });
      expect(() =>
        lowerProviderPatch(value.patch, value.registry, value.identity, telemetry()),
      ).toThrow(/forbidden fields/);
    },
  );

  it('rejects duplicate conflicting edits', async () => {
    const value = await setup();
    value.patch.changes.push({ ...value.patch.changes[0] });
    expect(() =>
      lowerProviderPatch(value.patch, value.registry, value.identity, telemetry()),
    ).toThrow(/duplicate conflicting edit handle/);
  });

  it('rejects distinct handles that resolve to the same path', async () => {
    const value = await setup();
    const second = {
      ...structuredClone(value.editableGrant),
      handle: `E${value.registry.nextHandle}`,
    };
    value.registry.nextHandle += 1;
    value.registry.grants.push(second);
    persistEditGrantRegistry(repo.path, value.registry);
    value.patch.changes.push({
      ...value.patch.changes[0],
      editHandle: second.handle,
    });
    expect(() =>
      lowerProviderPatch(value.patch, value.registry, value.identity, telemetry()),
    ).toThrow(/same path/);
  });

  it('rejects an operation not granted by the handle', async () => {
    const value = await setup();
    Object.assign(value.patch.changes[0], { operation: 'delete_file' });
    expect(() =>
      lowerProviderPatch(value.patch, value.registry, value.identity, telemetry()),
    ).toThrow(/unsupported provider operation/);
  });

  it('does not permit edits through a read-only test-page handle', async () => {
    const value = await setup();
    expect(value.readOnlyGrant.permissions).toEqual([]);
    value.patch.changes[0].editHandle = value.readOnlyGrant.handle;
    expect(() =>
      lowerProviderPatch(value.patch, value.registry, value.identity, telemetry()),
    ).toThrow(/read-only/);
  });

  it('preserves handles and a stable digest after persistence and reload', async () => {
    const value = await setup();
    const before = structuredClone(value.registry);
    const loaded = loadEditGrantRegistry(repo.path, value.task.id);
    expect(loaded.grants.map((grant) => grant.handle)).toEqual(
      before.grants.map((grant) => grant.handle),
    );
    expect(loaded.mappingSha256).toBe(before.mappingSha256);
    expect(editGrantMappingDigest(loaded)).toBe(loaded.mappingSha256);
  });

  it('assigns a new valid handle to a newly faulted context page', async () => {
    const value = await setup();
    const previousHandles = new Set(value.registry.grants.map((grant) => grant.handle));
    const loaded = value.kernel.resolve({
      reason: 'Need auxiliary implementation',
      pathHint: 'src/auxiliary.js',
    });
    await syncEditGrantRegistry(repo.path, value.registry, value.kernel.pages);
    const grant = grantForPage(value.registry, loaded);
    expect(grant?.handle).toMatch(/^E[1-9]\d*$/);
    expect(previousHandles.has(grant!.handle)).toBe(false);
    expect(grant?.permissions).toContain('replace_file');
  });

  it('keeps stale-source rejection after lowering', async () => {
    const value = await setup();
    const metrics = telemetry();
    const internal = lowerProviderPatch(
      value.patch,
      value.registry,
      value.identity,
      metrics,
    );
    const path = join(repo.path, value.editablePage.path);
    const original = readFileSync(path);
    try {
      writeFileSync(path, 'module.exports = 999;\n');
      await expect(
        transact(repo.path, internal, ['npm test'], metrics),
      ).rejects.toThrow(/stale source/);
    } finally {
      writeFileSync(path, original);
    }
  });

  it('rejects registry digest tampering', async () => {
    const value = await setup();
    const registry = cloneRegistry(value.registry);
    registry.grants[0].path = 'src/substituted.js';
    expect(() =>
      lowerProviderPatch(value.patch, registry, value.identity, telemetry()),
    ).toThrow(/integrity/);
  });
});

describe('runtime state machine', () => {
  it('follows the allowed successful state graph', () => {
    const metrics = telemetry();
    const machine = new RuntimeStateMachine(metrics);
    for (const state of [
      'COMPILED',
      'INDEXED',
      'CONTEXT_GRANTED',
      'WORKER_RUNNING',
      'RESPONSE_NORMALIZED',
      'RESPONSE_VALIDATED',
      'PATCH_LOWERED',
      'TRANSACTION_RUNNING',
      'VERIFYING',
      'PASSED',
    ] as const) {
      machine.transition(state);
    }
    expect(metrics.runtimeStateTransitions.map((transition) => transition.to)).toEqual([
      'CREATED',
      'COMPILED',
      'INDEXED',
      'CONTEXT_GRANTED',
      'WORKER_RUNNING',
      'RESPONSE_NORMALIZED',
      'RESPONSE_VALIDATED',
      'PATCH_LOWERED',
      'TRANSACTION_RUNNING',
      'VERIFYING',
      'PASSED',
    ]);
  });

  it('permits bounded protocol-repair and context-fault loops', () => {
    const machine = new RuntimeStateMachine(telemetry());
    machine.transition('COMPILED');
    machine.transition('INDEXED');
    machine.transition('CONTEXT_GRANTED');
    machine.transition('WORKER_RUNNING');
    machine.transition('PROTOCOL_REPAIR');
    machine.transition('WORKER_RUNNING');
    machine.transition('RESPONSE_NORMALIZED');
    machine.transition('RESPONSE_VALIDATED');
    machine.transition('CONTEXT_FAULT');
    machine.transition('CONTEXT_GRANTED');
    machine.transition('WORKER_RUNNING');
    expect(machine.state).toBe('WORKER_RUNNING');
  });

  it('fails illegal and terminal transitions deterministically', () => {
    const machine = new RuntimeStateMachine(telemetry());
    expect(() => machine.transition('TRANSACTION_RUNNING')).toThrow(
      /illegal runtime transition/,
    );
    machine.transition('FAILED', 'test failure');
    expect(() => machine.transition('COMPILED')).toThrow(/illegal runtime transition/);
  });
});
