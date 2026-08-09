import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInheritedProcess } from './managed-process.js';

const require = createRequire(import.meta.url);

export function bundledClaudeExecutable() {
  const platformPackage =
    process.platform === 'win32' && process.arch === 'x64'
      ? '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
        : process.platform === 'darwin' && process.arch === 'x64'
          ? '@anthropic-ai/claude-agent-sdk-darwin-x64/claude'
          : process.platform === 'linux' && process.arch === 'arm64'
            ? '@anthropic-ai/claude-agent-sdk-linux-arm64/claude'
            : process.platform === 'linux' && process.arch === 'x64'
              ? '@anthropic-ai/claude-agent-sdk-linux-x64/claude'
              : null;
  if (!platformPackage) {
    throw new Error(`unsupported Claude Code platform: ${process.platform}/${process.arch}`);
  }
  return require.resolve(platformPackage);
}

export function claudeCommandArguments(
  arguments_: readonly string[],
  raw = false,
) {
  return raw
    ? [
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        ...arguments_,
      ]
    : [...arguments_];
}

export async function runClaudeCommand(
  arguments_: readonly string[],
  options: {
    raw?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    executable?: string;
  } = {},
) {
  const executable = options.executable ?? bundledClaudeExecutable();
  const raw = options.raw === true;
  const argumentsWithIsolation = claudeCommandArguments(arguments_, raw);
  const result = await runInheritedProcess(executable, argumentsWithIsolation, {
    cwd: resolve(options.cwd ?? process.cwd()),
    env: {
      ...process.env,
      ...options.env,
      ...(raw ? { LATTICE_CLAUDE_RAW: '1' } : {}),
    },
  });
  process.exitCode = result.exitCode ?? 1;
  return { ...result, raw };
}

