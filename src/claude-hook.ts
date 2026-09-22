#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stdin } from 'node:process';

const MAX_HOOK_INPUT_BYTES = 64 * 1024;

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

async function readInput() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error(`Claude hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? (JSON.parse(text) as unknown) : {};
}

// This hook runs before and after every matched tool call, so it loads only
// what the event needs: one repository discovery (a single Git process) is
// shared by both consumers, and the sidecar-backed session sync is loaded
// only where Claude reports model settings.
async function runHook() {
  try {
    const input = await readInput();
    const event =
      input && typeof input === 'object' && 'hook_event_name' in input
        ? (input as { hook_event_name?: unknown }).hook_event_name
        : undefined;
    const { discoverRepository } = await import('./repository.js');
    const discoveries = new Map<string, ReturnType<typeof discoverRepository>>();
    const discover = (start: string) => {
      if (!discoveries.has(start)) discoveries.set(start, discoverRepository(start));
      return discoveries.get(start)!;
    };
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      try {
        const { runClaudeSessionSyncValue } = await import('./claude-session-sync.js');
        await runClaudeSessionSyncValue(input, { discover });
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

if (process.env.LATTICE_CLAUDE_RAW !== '1') await runHook();
process.exitCode = 0;
