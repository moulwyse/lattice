import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { metadata, readJson, uid, writeJson } from './core.js';
import { telemetry } from './telemetry.js';
import type { Telemetry } from './types.js';

export type Session = {
  schemaVersion: 1;
  id: string;
  workspace: string;
  worker: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskResult = {
  schemaVersion: 2;
  taskId: string;
  sessionId: string;
  status: 'running' | 'passed' | 'partial' | 'failed' | 'cancelled';
  failureStage?: string;
  error?: string;
  telemetry: Telemetry;
  [key: string]: unknown;
};

export function newSession(workspace: string, worker: string) {
  const now = new Date().toISOString();
  const session: Session = {
    schemaVersion: 1,
    id: uid(),
    workspace,
    worker,
    createdAt: now,
    updatedAt: now,
  };
  writeJson(join(metadata(workspace), 'sessions', `${session.id}.json`), session);
  return session;
}

export const saveSession = (session: Session) => {
  session.updatedAt = new Date().toISOString();
  writeJson(
    join(metadata(session.workspace), 'sessions', `${session.id}.json`),
    session,
  );
};

export const saveTask = (workspace: string, result: TaskResult) =>
  writeJson(join(metadata(workspace), 'tasks', `${result.taskId}.json`), result);

export const loadTask = (workspace: string, id: string): TaskResult => {
  const value = readJson<TaskResult>(
    join(metadata(workspace), 'tasks', `${id}.json`),
  );
  return {
    ...value,
    schemaVersion: 2 as const,
    telemetry: { ...telemetry(), ...value.telemetry },
  } as TaskResult;
};

function migrateSession(value: Partial<Session> & { id: string; workspace: string; worker: string }) {
  const createdAt = value.createdAt ?? value.updatedAt ?? new Date(0).toISOString();
  return {
    ...value,
    schemaVersion: 1 as const,
    createdAt,
    updatedAt: value.updatedAt ?? createdAt,
  } as Session;
}

export function listSessions(workspace: string): Session[] {
  const directory = join(metadata(workspace), 'sessions');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      migrateSession(
        readJson<Partial<Session> & { id: string; workspace: string; worker: string }>(
          join(directory, name),
        ),
      ),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function loadSession(workspace: string, id: string): Session {
  return migrateSession(
    readJson<Partial<Session> & { id: string; workspace: string; worker: string }>(
      join(metadata(workspace), 'sessions', `${id}.json`),
    ),
  );
}

export function resetSession(workspace: string, id: string) {
  const path = join(metadata(workspace), 'sessions', `${id}.json`);
  if (!existsSync(path)) throw new Error(`Session not found: ${id}`);
  rmSync(path);
}
