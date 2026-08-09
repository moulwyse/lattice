#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stdin } from 'node:process';

function recordError(error: unknown) {
  const localData = process.env.LOCALAPPDATA;
  if (!localData) return;
  try {
    const directory = join(localData, 'Lattice', 'claude-integration');
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, 'hook-errors.log'),
      `${new Date().toISOString()} ${
        error instanceof Error ? error.message : String(error)
      }`
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 1_000) + '\n',
      'utf8',
    );
  } catch {
    // Claude must remain usable even when diagnostics cannot be persisted.
  }
}

if (process.env.LATTICE_CLAUDE_RAW !== '1') {
  try {
    const {
      readClaudeHookInput,
      runClaudeSessionSyncValue,
    } = await import('./claude-session-sync.js');
    const { applyCodexLatticePolicy } = await import(
      './codex-lattice-policy.js'
    );
    const input = await readClaudeHookInput(stdin);
    const event =
      input && typeof input === 'object' && 'hook_event_name' in input
        ? (input as { hook_event_name?: unknown }).hook_event_name
        : undefined;
    if (
      event === 'SessionStart' ||
      event === 'UserPromptSubmit' ||
      event === 'PreToolUse' ||
      event === 'PostToolUse'
    ) {
      try {
        await runClaudeSessionSyncValue(input);
      } catch (error) {
        recordError(error);
      }
    }
    try {
      const output = await applyCodexLatticePolicy(input);
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      recordError(error);
    }
  } catch (error) {
    recordError(error);
  }
}
process.exitCode = 0;

