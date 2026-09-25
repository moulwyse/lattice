import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTask } from '../src/runtime.js';
import { repository, type TestRepository } from './helpers.js';

type Reply = (text: string, options: { outputSchema?: unknown }) => string;

// A scripted local stand-in for the Codex SDK: no model request is made.
const script: { replies: Reply[]; calls: { text: string; outputSchema?: unknown }[] } = {
  replies: [],
  calls: [],
};

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn(function () {
    const thread = () => ({
      id: 'scripted-thread',
      run: async (text: string, options: { outputSchema?: unknown }) => {
        script.calls.push({ text, outputSchema: options.outputSchema });
        const reply = script.replies.shift();
        if (!reply) throw new Error('scripted Codex ran out of replies');
        return { finalResponse: reply(text, options), items: [], usage: null };
      },
    });
    return { startThread: thread, resumeThread: thread };
  }),
}));

const files = {
  'package.json': JSON.stringify({ private: true, scripts: { test: 'node --test' } }),
  'src/value.js': 'module.exports = { value: 1 };\n',
  'tests/value.test.js':
    "const assert = require('node:assert/strict');\nconst test = require('node:test');\nconst { value } = require('../src/value.js');\ntest('value is two', () => assert.equal(value, 2));\n",
};

let repo: TestRepository | undefined;
beforeEach(() => {
  script.replies = [];
  script.calls = [];
});
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

function handleFor(prompt: string, path: string) {
  const handle = prompt.match(
    new RegExp(`"editHandle":"(E\\d+)","path":"${path.replaceAll('/', '\\/')}"`),
  )?.[1];
  if (!handle) throw new Error(`no granted handle for ${path} in prompt`);
  return handle;
}

let lastHandle = '';
function patch(changes: (handle: string) => unknown[], verificationCommands = ['npm test']): Reply {
  return (text) => {
    if (text.includes('DYNAMIC_GRANTED_CONTEXT')) lastHandle = handleFor(text, 'src/value.js');
    return JSON.stringify({
      kind: 'patch',
      patch: { summary: 'set value', changes: changes(lastHandle), verificationCommands },
    });
  };
}

const run = () =>
  runTask(repo!.path, 'Change the exported value to 2', {
    worker: 'codex',
    useVerifiedCache: false,
  });

describe('patch revision turns', () => {
  it('returns a rejected patch to the worker and applies the corrected one', async () => {
    repo = await repository(files);
    script.replies.push(
      patch((editHandle) => [
        {
          editHandle,
          operation: 'replace_text',
          replacements: [{ oldContent: 'value: one', newContent: 'value: 2' }],
        },
      ]),
      patch((editHandle) => [
        {
          editHandle,
          operation: 'replace_text',
          replacements: [{ oldContent: 'value: 1', newContent: 'value: 2' }],
        },
      ]),
    );
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('passed');
    expect(result.patchRevisions).toBe(1);
    expect(script.calls[1].text).toMatch(/^PATCH_REVISION\n/);
    expect(script.calls[1].text).toContain('replacement_outside_grant');
    expect(result.telemetry.turnUsage.map((turn: { kind: string }) => turn.kind)).toEqual([
      'initial',
      'patch_revision',
    ]);
    expect(
      result.telemetry.runtimeStateTransitions.map((transition: { to: string }) => transition.to),
    ).toContain('PATCH_REVISION');
  }, 60_000);

  it('returns failing verification output to the worker', async () => {
    repo = await repository(files);
    script.replies.push(
      patch((editHandle) => [
        { editHandle, operation: 'replace_file', replacementContent: 'module.exports = { value: 3 };\n' },
      ]),
      patch((editHandle) => [
        { editHandle, operation: 'replace_file', replacementContent: 'module.exports = { value: 2 };\n' },
      ]),
    );
    const result = await run();
    expect(result.status).toBe('passed');
    expect(result.patchRevisions).toBe(1);
    expect(script.calls[1].text).toContain('verification_failed');
    expect(script.calls[1].text).toContain('npm test exited with');
    // The rejected attempt stays on record even if the revision turn later fails.
    const saved = JSON.parse(
      readFileSync(join(repo.path, '.lattice', 'tasks', `${result.taskId}.json`), 'utf8'),
    );
    expect(saved.lastRejectedAttempt).toMatchObject({
      reason: 'verification_failed',
      changedFiles: ['src/value.js'],
    });
    expect(saved.lastRejectedAttempt.detail).toContain('npm test exited with');
    expect(readFileSync(join(repo.path, 'src/value.js'), 'utf8')).toBe(
      'module.exports = { value: 1 };\n',
    );
  }, 60_000);

  it('returns a verification command outside the allowlist to the worker', async () => {
    repo = await repository(files);
    const correct = (editHandle: string) => [
      { editHandle, operation: 'replace_file', replacementContent: 'module.exports = { value: 2 };\n' },
    ];
    script.replies.push(patch(correct, ['npx vitest run tests/value.test.js']), patch(correct));
    const result = await run();
    expect(result.status).toBe('passed');
    expect(result.patchRevisions).toBe(1);
    expect(script.calls[1].text).toContain('verification_command_not_allowed');
    expect(script.calls[1].text).toContain('npm test');
  }, 60_000);

  it('stops after the bounded number of revisions', async () => {
    repo = await repository(files);
    const wrong = patch((editHandle) => [
      { editHandle, operation: 'replace_file', replacementContent: 'module.exports = { value: 3 };\n' },
    ]);
    script.replies.push(wrong, wrong, wrong, wrong);
    const result = await run();
    expect(result.status).toBe('failed');
    expect(result.failureStage).toBe('verification');
    expect(result.patchRevisions).toBe(2);
    expect(script.calls).toHaveLength(3);
  }, 90_000);

  it('passes the output schema and retries without it when the provider rejects the schema', async () => {
    repo = await repository(files);
    script.replies.push(
      () => {
        throw new Error("Invalid schema for response_format 'codex_output_schema'");
      },
      patch((editHandle) => [
        { editHandle, operation: 'replace_file', replacementContent: 'module.exports = { value: 2 };\n' },
      ]),
    );
    const result = await run();
    expect(result.status).toBe('passed');
    expect(script.calls[0].outputSchema).toBeDefined();
    expect(script.calls[1].outputSchema).toBeUndefined();
  }, 60_000);
});
