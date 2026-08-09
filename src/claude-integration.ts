import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { metadata } from './core.js';
import {
  LATTICE_POST_TOOL_MATCHER,
  LATTICE_PRE_TOOL_MATCHER,
} from './codex-lattice-policy.js';
import { discoverRepository } from './repository.js';

type JsonRecord = Record<string, unknown>;

export type ClaudeIntegrationState = {
  schemaVersion: 1;
  workspace: string;
  mcpPath: string;
  settingsPath: string;
  statePath: string;
  mcpDefinition: JsonRecord;
  hookCommand: string;
  enabledMcpjsonServerAdded: boolean;
  mcpFileCreated?: boolean;
  settingsFileCreated?: boolean;
  enabledMcpjsonServersExisted?: boolean;
  enabledAt: string;
};

function readObject(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as JsonRecord;
}

function writeObject(path: string, value: JsonRecord) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellArgument(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function hookCommand(cliPath: string) {
  return `${shellArgument(process.execPath)} ${shellArgument(
    resolve(dirname(cliPath), 'claude-hook.js'),
  )}`;
}

function hookGroup(command: string, matcher?: string) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: 'command',
        command,
        timeout: 30,
        statusMessage: 'Preparing bounded Lattice context',
      },
    ],
  };
}

function hookCommands(group: unknown) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return [];
  const hooks = (group as JsonRecord).hooks;
  return Array.isArray(hooks)
    ? hooks
        .filter(
          (hook): hook is JsonRecord =>
            Boolean(hook) && typeof hook === 'object' && !Array.isArray(hook),
        )
        .map((hook) => hook.command)
    : [];
}

function addHook(
  hooks: JsonRecord,
  event: string,
  command: string,
  matcher?: string,
) {
  const current = Array.isArray(hooks[event]) ? [...hooks[event] as unknown[]] : [];
  if (!current.some((group) => hookCommands(group).includes(command))) {
    current.push(hookGroup(command, matcher));
  }
  hooks[event] = current;
}

function removeHook(hooks: JsonRecord, event: string, command: string) {
  const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  const remainingGroups: unknown[] = [];
  for (const group of current) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      remainingGroups.push(group);
      continue;
    }
    const record = { ...(group as JsonRecord) };
    const configured = Array.isArray(record.hooks) ? record.hooks : [];
    const remainingHooks = configured.filter(
      (hook) =>
        !hook ||
        typeof hook !== 'object' ||
        Array.isArray(hook) ||
        (hook as JsonRecord).command !== command,
    );
    if (remainingHooks.length > 0) {
      record.hooks = remainingHooks;
      remainingGroups.push(record);
    }
  }
  if (remainingGroups.length > 0) hooks[event] = remainingGroups;
  else delete hooks[event];
}

export function claudeIntegrationPaths(workspace: string) {
  const root = resolve(workspace);
  return {
    workspace: root,
    mcpPath: join(root, '.mcp.json'),
    settingsPath: join(root, '.claude', 'settings.local.json'),
    statePath: join(root, '.lattice', 'claude-integration.json'),
  };
}

export function readClaudeIntegrationState(
  workspace: string,
): ClaudeIntegrationState | null {
  const { statePath } = claudeIntegrationPaths(workspace);
  if (!existsSync(statePath)) return null;
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as ClaudeIntegrationState;
    return value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export async function enableClaudeIntegration(options: {
  workspace: string;
  cliPath: string;
}) {
  const repository = await discoverRepository(options.workspace);
  if (!repository.safe) {
    throw new Error(`Claude integration requires a safe repository: ${repository.reason}`);
  }
  const existing = readClaudeIntegrationState(repository.root);
  if (existing) {
    const status = await claudeIntegrationStatus(repository.root);
    if (status.enabled) return { changed: false as const, state: existing };
    throw new Error(
      'Claude integration has a partial or changed ownership receipt; run integration claude disable before enabling again.',
    );
  }
  metadata(repository.root);
  const paths = claudeIntegrationPaths(repository.root);
  const command = hookCommand(options.cliPath);
  const mcpDefinition = {
    type: 'stdio',
    command: process.execPath,
    args: [resolve(options.cliPath), 'mcp-server'],
    env: {
      LATTICE_WORKSPACE: repository.root,
    },
  };

  const mcpFileCreated = !existsSync(paths.mcpPath);
  const settingsFileCreated = !existsSync(paths.settingsPath);
  const mcp = readObject(paths.mcpPath);
  const servers =
    mcp.mcpServers &&
    typeof mcp.mcpServers === 'object' &&
    !Array.isArray(mcp.mcpServers)
      ? { ...mcp.mcpServers as JsonRecord }
      : {};
  if (servers.lattice && !sameJson(servers.lattice, mcpDefinition)) {
    throw new Error(
      'A different project MCP server named "lattice" already exists; it was preserved.',
    );
  }
  const settings = readObject(paths.settingsPath);
  const hooks =
    settings.hooks &&
    typeof settings.hooks === 'object' &&
    !Array.isArray(settings.hooks)
      ? { ...settings.hooks as JsonRecord }
      : {};
  addHook(hooks, 'SessionStart', command);
  addHook(hooks, 'UserPromptSubmit', command);
  addHook(hooks, 'SubagentStart', command);
  addHook(hooks, 'PreToolUse', command, LATTICE_PRE_TOOL_MATCHER);
  addHook(hooks, 'PostToolUse', command, LATTICE_POST_TOOL_MATCHER);
  settings.hooks = hooks;
  const enabledServers = Array.isArray(settings.enabledMcpjsonServers)
    ? settings.enabledMcpjsonServers.filter((value) => typeof value === 'string')
    : [];
  const enabledMcpjsonServerAdded = !enabledServers.includes('lattice');
  const enabledMcpjsonServersExisted = Object.prototype.hasOwnProperty.call(
    settings,
    'enabledMcpjsonServers',
  );

  const state: ClaudeIntegrationState = {
    schemaVersion: 1,
    ...paths,
    mcpDefinition,
    hookCommand: command,
    enabledMcpjsonServerAdded,
    mcpFileCreated,
    settingsFileCreated,
    enabledMcpjsonServersExisted,
    enabledAt: new Date().toISOString(),
  };
  writeObject(paths.statePath, state as unknown as JsonRecord);
  try {
    servers.lattice = mcpDefinition;
    mcp.mcpServers = servers;
    writeObject(paths.mcpPath, mcp);
    settings.enabledMcpjsonServers = [...new Set([...enabledServers, 'lattice'])];
    writeObject(paths.settingsPath, settings);
    return { changed: true as const, state };
  } catch (error) {
    const rollback = await disableClaudeIntegration(repository.root).catch(
      (rollbackError: unknown) => ({
        changed: false as const,
        warnings: [
          `rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        ],
      }),
    );
    if (rollback.warnings.length > 0) {
      throw new AggregateError(
        [error, ...rollback.warnings.map((warning) => new Error(warning))],
        'Claude integration enable failed and rollback was incomplete',
      );
    }
    throw error;
  }
}

export async function disableClaudeIntegration(workspace: string) {
  const state = readClaudeIntegrationState(workspace);
  if (!state) return { changed: false as const, warnings: [] as string[] };
  const warnings: string[] = [];

  const mcp = readObject(state.mcpPath);
  const servers =
    mcp.mcpServers &&
    typeof mcp.mcpServers === 'object' &&
    !Array.isArray(mcp.mcpServers)
      ? { ...mcp.mcpServers as JsonRecord }
      : {};
  if (sameJson(servers.lattice, state.mcpDefinition)) {
    delete servers.lattice;
    if (Object.keys(servers).length > 0) mcp.mcpServers = servers;
    else delete mcp.mcpServers;
    if (state.mcpFileCreated === true && Object.keys(mcp).length === 0) {
      rmSync(state.mcpPath, { force: true });
    } else {
      writeObject(state.mcpPath, mcp);
    }
  } else if (servers.lattice) {
    warnings.push('The lattice MCP definition changed and was preserved.');
  }

  const settings = readObject(state.settingsPath);
  const hooks =
    settings.hooks &&
    typeof settings.hooks === 'object' &&
    !Array.isArray(settings.hooks)
      ? { ...settings.hooks as JsonRecord }
      : {};
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'SubagentStart',
    'PreToolUse',
    'PostToolUse',
  ]) {
    removeHook(hooks, event, state.hookCommand);
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  if (
    state.enabledMcpjsonServerAdded !== false &&
    Array.isArray(settings.enabledMcpjsonServers)
  ) {
    const remaining = settings.enabledMcpjsonServers.filter(
      (value) => value !== 'lattice',
    );
    if (remaining.length > 0 || state.enabledMcpjsonServersExisted === true) {
      settings.enabledMcpjsonServers = remaining;
    } else {
      delete settings.enabledMcpjsonServers;
    }
  }
  if (state.settingsFileCreated === true && Object.keys(settings).length === 0) {
    rmSync(state.settingsPath, { force: true });
  } else {
    writeObject(state.settingsPath, settings);
  }
  rmSync(state.statePath, { force: true });
  return { changed: true as const, warnings };
}

export async function claudeIntegrationStatus(workspace: string) {
  const paths = claudeIntegrationPaths(workspace);
  const state = readClaudeIntegrationState(workspace);
  if (!state) {
    return {
      configured: false as const,
      enabled: false,
      paths,
      mcpMatched: false,
      hooksMatched: false,
    };
  }
  const mcp = readObject(state.mcpPath);
  const servers =
    mcp.mcpServers &&
    typeof mcp.mcpServers === 'object' &&
    !Array.isArray(mcp.mcpServers)
      ? mcp.mcpServers as JsonRecord
      : {};
  const settings = readObject(state.settingsPath);
  const hooks =
    settings.hooks &&
    typeof settings.hooks === 'object' &&
    !Array.isArray(settings.hooks)
      ? settings.hooks as JsonRecord
      : {};
  const hooksMatched = [
    'SessionStart',
    'UserPromptSubmit',
    'SubagentStart',
    'PreToolUse',
    'PostToolUse',
  ].every((event) =>
    (Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []).some((group) =>
      hookCommands(group).includes(state.hookCommand),
    ),
  );
  const mcpMatched = sameJson(servers.lattice, state.mcpDefinition);
  return {
    configured: true as const,
    enabled: mcpMatched && hooksMatched,
    paths,
    state,
    mcpMatched,
    hooksMatched,
  };
}

