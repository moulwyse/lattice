import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { dashboardData, renderDashboard } from '../src/dashboard.js';
import { claudeMessageCost, claudePrice } from '../src/pricing.js';
import { knownRepositoriesPath, readKnownRepositories, rememberRepository } from '../src/repositories.js';
import { collectAllProjects, collectStats, combineStats, formatStats } from '../src/stats.js';

function directory() {
  return resolve(mkdtempSync(join(tmpdir(), 'lattice-projects-test-')));
}

/** An isolated profile: settings, known repositories and empty agent logs. */
function environment() {
  return {
    ...process.env,
    LATTICE_SETTINGS_PATH: join(directory(), 'settings.json'),
    LATTICE_NO_UPDATE_CHECK: '1',
    CLAUDE_CONFIG_DIR: directory(),
    CODEX_HOME: directory(),
  };
}

type Task = { status: string; goal: string; at: string; input?: number; cost?: number; source?: number; loaded?: number };

/** A project with Lattice state and the given `lattice run` task records. */
function project(name: string, tasks: Task[] = [], parent = directory()) {
  const root = join(parent, name);
  mkdirSync(join(root, '.lattice', 'tasks'), { recursive: true });
  tasks.forEach((task, index) =>
    writeFileSync(
      join(root, '.lattice', 'tasks', `${index}.json`),
      JSON.stringify({
        status: task.status,
        goal: task.goal,
        telemetry: {
          modelInputTokens: task.input ?? 0,
          outputTokens: 10,
          costUsd: task.cost ?? 0,
          loadedContextCharacters: task.loaded ?? 0,
          ...(task.source === undefined ? {} : { sourceFileBytes: task.source }),
          runtimeStateTransitions: [{ at: task.at }],
        },
      }),
    ),
  );
  return root;
}

/** One Claude Code desktop message in `cwd` for the given model. */
function claudeSession(env: ReturnType<typeof environment>, cwd: string, model = 'claude-sonnet-5') {
  const folder = join(env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${Math.random().toString(36).slice(2)}.jsonl`),
    `${JSON.stringify({
      type: 'assistant',
      cwd,
      entrypoint: 'claude-desktop',
      timestamp: '2026-09-25T10:00:00.000Z',
      message: { id: 'msg', model, usage: { input_tokens: 1_000_000, output_tokens: 100_000 } },
    })}\n`,
  );
}

describe('model prices', () => {
  test('match the longest model id first and accept dated or provider ids', () => {
    expect(claudePrice('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(claudePrice('claude-opus-5')).toMatchObject({ input: 5, output: 25 });
    expect(claudePrice('claude-opus-5-20260101')).toMatchObject({ input: 5 });
    expect(claudePrice('us.anthropic.claude-sonnet-5')).toMatchObject({ input: 2 });
    expect(claudePrice('claude-haiku-4-5-20251001')).toMatchObject({ input: 1 });
    expect(claudePrice('gpt-6-astra')).toBeNull();
    expect(claudePrice('<synthetic>')).toBeNull();
  });

  test('price cache writes, one-hour writes, cache reads and output', () => {
    const cost = claudeMessageCost('claude-sonnet-5', {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 400_000 },
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    // $2 in + 0.6M x $2.50 + 0.4M x $4 + $0.20 cache reads + $10 out.
    expect(cost).toBeCloseTo(2 + 1.5 + 1.6 + 0.2 + 10, 10);
    expect(claudeMessageCost('unknown-model', { input_tokens: 5 })).toBeNull();
  });
});

describe('known repositories', () => {
  test('are remembered once next to the user settings', () => {
    const env = environment();
    const root = project('alpha');
    rememberRepository(root, env);
    rememberRepository(root, env);
    expect(readKnownRepositories(env)).toEqual([root]);
    expect(knownRepositoriesPath(env)).toBe(join(resolve(env.LATTICE_SETTINGS_PATH, '..'), 'repositories.json'));
    expect(JSON.parse(readFileSync(knownRepositoriesPath(env), 'utf8'))).toMatchObject({ schemaVersion: 1 });
  });
});

describe('all projects', () => {
  test('are found from the known list and from agent sessions, then summed', () => {
    const env = environment();
    const parent = directory();
    const alpha = project(
      'alpha',
      [
        { status: 'passed', goal: 'Fix login redirect', at: '2026-09-20T10:00:00.000Z', input: 1_000, cost: 0.01, source: 50_000, loaded: 10_000 },
        { status: 'failed', goal: 'Refactor auth tokens', at: '2026-09-22T10:00:00.000Z', input: 500, cost: 0.005 },
      ],
      parent,
    );
    const beta = project('beta', [{ status: 'passed', goal: 'Add audit log', at: '2026-09-21T10:00:00.000Z' }], parent);
    rememberRepository(alpha, env);
    // Beta is only known from a chat that ran in one of its subdirectories.
    mkdirSync(join(beta, 'src'));
    claudeSession(env, join(beta, 'src'));
    // Neither a folder without Lattice state nor a Lattice worktree is a project.
    claudeSession(env, directory());
    mkdirSync(join(alpha, '.lattice', 'worktrees', 'wt', '.lattice'), { recursive: true });
    claudeSession(env, join(alpha, '.lattice', 'worktrees', 'wt'));

    const projects = collectAllProjects(env);
    expect(projects.map((item) => item.name)).toEqual(['alpha', 'beta']);
    const total = combineStats(projects, env);
    expect(total.tasks).toMatchObject({ total: 3, passed: 2, failed: 1, inputTokens: 1_500, prunedBytes: 40_000 });
    expect(total.recentTasks.map((task) => `${task.project}/${task.name}`)).toEqual([
      'alpha/refactor-auth-tokens',
      'beta/add-audit-log',
      'alpha/fix-login-redirect',
    ]);
    // The worktree session counts for alpha, the beta chat for beta.
    expect(total.agents).toHaveLength(1);
    expect(total.agents[0]).toMatchObject({ sessions: 2, inputTokens: 2_000_000 });
    // Sonnet 5: $2 in and $1 out per session, plus $0.015 of tasks.
    expect(total.estimates.costUsd).toBeCloseTo(6.015, 6);
    // 40,000 pruned bytes = 10,000 tokens at Sonnet 5's $2 per million.
    expect(total.estimates).toMatchObject({ prunedTokens: 10_000, unpricedSessions: false });
    expect(total.estimates.savedUsd).toBeCloseTo(0.02, 6);

    const report = formatStats(total, 'ru', projects);
    expect(report).toContain('Проекты (2)');
    expect(report).toMatch(/alpha: 2 задачи, отправлено 1\s001\s500 токенов, отсечено ≈10\s000/);
    expect(report).toContain('Сессии Claude Code и Codex в этих проектах');
    expect(report).toContain('Все проекты');
    expect(report).toContain('Оценки');
    expect(report).not.toContain('Репозиторий:');
  });

  test('lattice stats outside a repository shows every project', async () => {
    const env = environment();
    const alpha = project('alpha', [
      { status: 'passed', goal: 'Fix login redirect', at: '2026-09-20T10:00:00.000Z', input: 1_000, cost: 0.01, source: 50_000, loaded: 10_000 },
      { status: 'failed', goal: 'Refactor auth tokens', at: '2026-09-22T10:00:00.000Z', input: 500, cost: 0.005 },
    ]);
    rememberRepository(alpha, env);
    writeFileSync(env.LATTICE_SETTINGS_PATH, JSON.stringify({ schemaVersion: 1, language: 'en' }));
    const written = renderDashboard(await dashboardData(directory(), env), 'en', false);
    expect(written).toContain('all projects (1)');
    expect(written).toMatch(/│ Tokens\s+1,500 sent\s+~10,000 pruned \(est\.\)\s+│/);
    expect(written).toMatch(/│ Est\. cost\s+\$0\.015\s+~\$0\.10 saved \(est\.\)\s+│/);
    expect(written).toMatch(/│ Tasks\s+2 total\s+✓ 1 {2}✗ 1\s+│/);
    expect(written).toMatch(/┌─ PROJECTS[\s\S]*│ alpha\s+2 tasks\s+1,500 · ~10,000\s+│/);
    expect(written).toMatch(/✗ alpha\/refactor-au…/);
    expect(written).toContain('● ready');
    const boxLines = written.split('\n').filter((line) => /^\s*[┌│└]/.test(line));
    expect(new Set(boxLines.map((line) => [...line].length)).size).toBe(1);
  });

  test('without any project the screen says how to start', () => {
    const env = environment();
    const projects = collectAllProjects(env);
    const text = renderDashboard(
      { stats: combineStats(projects, env), project: 'home', branch: null, engine: null, projects },
      'ru',
      false,
    );
    expect(text).toContain('все проекты (0)');
    expect(text).toContain('проектов Lattice пока нет');
    expect(text).not.toContain('МЕТРИКИ');
    expect(formatStats(combineStats(projects, env), 'en', projects)).toContain('No Lattice projects found yet');
  });

  test('a single repository keeps its own view', () => {
    const env = environment();
    const stats = collectStats(project('solo', [{ status: 'passed', goal: 'x', at: '2026-09-20T10:00:00.000Z' }]), env);
    const text = renderDashboard({ stats, project: 'solo', branch: 'main', engine: null }, 'en', false);
    expect(text).toContain('solo · git:main');
    expect(text).not.toContain('PROJECTS');
  });
});
