#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stdin } from 'node:process';

function recordError(error: unknown) {
  // Keep a bounded local diagnostic without copying hook input or prompts.
  // This file is useful when a Codex build changes the hook transport shape.
  const localData = process.env.LOCALAPPDATA;
  if (localData) {
    try {
      const directory = join(localData, 'Lattice', 'codex-integration');
      mkdirSync(directory, { recursive: true });
      appendFileSync(
        join(directory, 'hook-errors.log'),
        `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 1_000) + '\n',
        'utf8',
      );
    } catch {
      // Diagnostics must not affect the hook result.
    }
  }
}

// Lifecycle synchronization and policy enforcement share one bounded parse of
// stdin. Any internal failure remains fail-open so native Codex is never made
// unusable by a broken sidecar or a changed hook transport. Raw launches
// (codex-raw / lattice codex --raw) bypass Lattice completely.
async function runHook() {
  try {
    const { readCodexHookInput } = await import('./hook-input.js');
    const input = await readCodexHookInput(stdin);
    const event =
      input && typeof input === 'object' && 'hook_event_name' in input
        ? (input as { hook_event_name?: unknown }).hook_event_name
        : undefined;
    // One repository discovery (one Git process) serves both consumers, and
    // the sidecar-backed session sync loads only for the events that use it.
    const { discoverRepository } = await import('./repository.js');
    const discoveries = new Map<string, ReturnType<typeof discoverRepository>>();
    const discover = (start: string) => {
      if (!discoveries.has(start)) discoveries.set(start, discoverRepository(start));
      return discoveries.get(start)!;
    };
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      try {
        const { runCodexSessionSyncValue } = await import('./codex-session-sync.js');
        await runCodexSessionSyncValue(input, { discover });
      } catch (error) {
        recordError(error);
      }
    }
    try {
      const { applyCodexLatticePolicy } = await import('./codex-lattice-policy.js');
      const output = await applyCodexLatticePolicy(input, { discover });
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      recordError(error);
    }
  } catch (error) {
    recordError(error);
  }
}

if (process.env.LATTICE_CODEX_RAW !== '1') await runHook();
process.exitCode = 0;
