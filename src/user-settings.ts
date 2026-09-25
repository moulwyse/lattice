import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeJson } from './core.js';
import { isLanguage, type Language } from './i18n.js';

/** Per-user preferences shared by the menu, `lattice stats` and the MCP bridge. */
export type UserSettings = {
  schemaVersion: 1;
  language?: Language;
  lastUpdateCheck?: {
    checkedAt: string;
    latestVersion: string | null;
  };
};

export function userSettingsPath(env: NodeJS.ProcessEnv = process.env) {
  if (env.LATTICE_SETTINGS_PATH) return resolve(env.LATTICE_SETTINGS_PATH);
  const base =
    env.LOCALAPPDATA ??
    (process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Local')
      : join(homedir(), '.local', 'share'));
  return join(base, 'Lattice', 'settings.json');
}

/** A missing or unreadable file yields defaults: settings never block a command. */
export function readUserSettings(env: NodeJS.ProcessEnv = process.env): UserSettings {
  const path = userSettingsPath(env);
  if (!existsSync(path)) return { schemaVersion: 1 };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const settings: UserSettings = { schemaVersion: 1 };
    if (isLanguage(value.language)) settings.language = value.language;
    const check = value.lastUpdateCheck as Record<string, unknown> | undefined;
    if (
      check &&
      typeof check.checkedAt === 'string' &&
      (typeof check.latestVersion === 'string' || check.latestVersion === null)
    ) {
      settings.lastUpdateCheck = {
        checkedAt: check.checkedAt,
        latestVersion: check.latestVersion,
      };
    }
    return settings;
  } catch {
    return { schemaVersion: 1 };
  }
}

export function updateUserSettings(
  change: Partial<Omit<UserSettings, 'schemaVersion'>>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const next: UserSettings = { ...readUserSettings(env), ...change, schemaVersion: 1 };
  try {
    writeJson(userSettingsPath(env), next);
  } catch {
    // An unwritable profile directory only means the choice is asked again.
  }
  return next;
}
