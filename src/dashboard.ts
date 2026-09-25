import { basename } from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { execa } from 'execa';
import {
  fileCount,
  LANGUAGES,
  taskCount,
  languageFromLocale,
  sessionCount,
  translate,
  type Language,
} from './i18n.js';
import { collectHistory } from './history.js';
import { renderHistoryList, runHistoryMenu } from './menu.js';
import { discoverRepository } from './repository.js';
import { rememberRepository } from './repositories.js';
import {
  agentLabel,
  collectAllProjects,
  collectStats,
  combineStats,
  formatBytes,
  type LatticeStats,
  type ProjectStats,
  type RecentTask,
} from './stats.js';
import {
  checkForUpdate,
  detectInstallation,
  installRelease,
  manualUpdateCommand,
  updateCheckDisabled,
} from './update-check.js';
import { readUserSettings, updateUserSettings } from './user-settings.js';
import { LATTICE_VERSION } from './version.js';

type Terminal = { input: NodeJS.ReadStream; output: NodeJS.WriteStream };

const INNER_WIDTH = 64;

/**
 * The Lattice logo, one terminal cell per character: `#` is a letter cell and
 * `+` its shadow. Traced cell by cell from the reference artwork.
 */
const LOGO = [
  '..####.............#####.....#####.....###......................',
  '.++###............++###.....++###.....+++.......................',
  '..+###...######...#######...#######...####...#######...######...',
  '..+###..+++++###.+++###+...+++###+...++###..###+++###.###++###..',
  '..+###...#######...+###......+###.....+###.+###.++++.+#######...',
  '..+###..###++###...+###.###..+###.###.+###.+###...###+###+++....',
  '..#####++########..++#####...++#####..#####++#######.++######...',
  '.+++++..++++++++....+++++.....+++++..+++++..+++++++...++++++....',
];

type Palette = {
  text: (value: string) => string;
  shadow: (value: string) => string;
  dim: (value: string) => string;
  bold: (value: string) => string;
  green: (value: string) => string;
  red: (value: string) => string;
  yellow: (value: string) => string;
  border: (value: string) => string;
};

function palette(color: boolean): Palette {
  const wrap = (code: string) => (value: string) =>
    color && value ? `\x1b[${code}m${value}\x1b[0m` : value;
  return {
    text: wrap('38;2;236;239;244'),
    shadow: wrap('38;2;59;66;82'),
    dim: wrap('38;2;128;134;145'),
    bold: wrap('1;38;2;236;239;244'),
    green: wrap('38;2;63;185;80'),
    red: wrap('38;2;248;81;73'),
    yellow: wrap('38;2;210;153;34'),
    border: wrap('38;2;110;118;129'),
  };
}

/** One `█` per logo cell; without color only the letters are drawn. */
export function renderLogo(color: boolean) {
  const colors = palette(color);
  return LOGO.map((row) =>
    (row.replace(/\.+$/, '').match(/#+|\++|\.+/g) ?? [])
      .map((run) => {
        const cells = run.length;
        if (run[0] === '#') return colors.text('█'.repeat(cells));
        if (run[0] === '+' && color) return colors.shadow('█'.repeat(cells));
        return ' '.repeat(cells);
      })
      .join(''),
  );
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const visibleLength = (value: string) => [...value.replace(ANSI, '')].length;

function fit(value: string, width: number) {
  const characters = [...value];
  return characters.length <= width ? value : `${characters.slice(0, width - 1).join('')}…`;
}

function pad(value: string, width: number) {
  return value + ' '.repeat(Math.max(0, width - visibleLength(value)));
}

function box(title: string, rows: string[], colors: Palette) {
  const top = `${colors.border('┌─')} ${colors.bold(title)} ${colors.border(`${'─'.repeat(Math.max(0, INNER_WIDTH - visibleLength(title) - 1))}┐`)}`;
  const body = rows.map((row) => `${colors.border('│')} ${pad(row, INNER_WIDTH)} ${colors.border('│')}`);
  return [top, ...body, colors.border(`└${'─'.repeat(INNER_WIDTH + 2)}┘`)];
}

export type DashboardData = {
  stats: LatticeStats | null;
  project: string;
  branch: string | null;
  engine: string | null;
  /** Set outside a repository: every known project, summed into `stats`. */
  projects?: ProjectStats[];
};

function contextRow(stats: LatticeStats, language: Language, colors: Palette) {
  const label = pad(translate(language, 'dashContext'), 12);
  const average =
    stats.context.calls > 0
      ? stats.context.bytes / stats.context.calls
      : stats.tasks.total > 0 && stats.tasks.contextCharacters > 0
        ? stats.tasks.contextCharacters / stats.tasks.total
        : null;
  if (average === null) return label + colors.dim(translate(language, 'dashNoContext'));
  if (!stats.index || stats.index.bytes === 0) {
    return label + formatBytes(average, language);
  }
  const share = average / stats.index.bytes;
  const cells = 20;
  const filled = Math.min(cells, Math.max(share > 0 ? 1 : 0, Math.round(share * cells)));
  const bar = `[${colors.green('█'.repeat(filled))}${colors.shadow('░'.repeat(cells - filled))}]`;
  const percent = new Intl.NumberFormat(language, {
    style: 'percent',
    maximumFractionDigits: share < 0.1 ? 1 : 0,
  }).format(share);
  const sizes = pad(`${formatBytes(average, language)} / ${formatBytes(stats.index.bytes, language)}`, 23);
  return `${label}${sizes}${bar} ${percent}`;
}

function pipelineRow(task: RecentTask, language: Language, colors: Palette) {
  const seconds = (milliseconds: number) =>
    new Intl.NumberFormat(language, {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'narrow',
      maximumFractionDigits: 1,
    }).format(milliseconds / 1000);
  const mark =
    task.status === 'passed' ? colors.green('✓') : task.status === 'failed' ? colors.red('✗') : colors.yellow('•');
  const name = task.project ? `${task.project}/${task.name}` : task.name;
  const head = `${mark} ${pad(fit(name, 18), 19)}${pad(fileCount(language, task.files), 11)}`;
  const room = INNER_WIDTH - 32;
  if (task.status === 'passed') {
    const time = task.verificationMs === null ? '—' : seconds(task.verificationMs);
    return head + colors.dim(fit(translate(language, 'dashVerified', { time }), room));
  }
  const detail = translate(language, 'dashFailed', { reason: task.reason ?? '—' });
  return head + (task.status === 'failed' ? colors.red(fit(detail, room)) : colors.dim(fit(detail, room)));
}

const sentTokens = (stats: LatticeStats) =>
  stats.tasks.inputTokens + stats.agents.reduce((sum, group) => sum + group.inputTokens, 0);

const MAX_PROJECT_ROWS = 10;

export type DashboardOptions = {
  /** The pixel logo; left out where space is short. */
  logo?: boolean;
  /** The ready line with command hints; left out inside an agent chat. */
  footer?: boolean;
};

export function renderDashboard(
  data: DashboardData,
  language: Language,
  color: boolean,
  options: DashboardOptions = {},
) {
  const colors = palette(color);
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(language, key, values);
  // Session totals reach hundreds of millions; keep the columns readable.
  const tokens = (value: number) =>
    new Intl.NumberFormat(language, {
      notation: value >= 100_000 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(value);
  const money = (value: number) =>
    new Intl.NumberFormat(language, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: value >= 100 ? 0 : 3,
    }).format(value);
  const lines = options.logo === false ? [''] : ['', ...renderLogo(color).map((line) => `  ${line}`), ''];
  const projects = data.projects;
  const status = [
    `v${LATTICE_VERSION}`,
    projects ? t('dashAllProjects', { count: projects.length }) : data.project,
    ...(data.branch ? [`git:${data.branch}`] : []),
    `engine:${data.engine ?? t('dashNone')}`,
  ].join(' · ');
  lines.push(`  ${colors.dim(status)}`, '');
  // Without an integration, chats never call Lattice, so nothing is saved there.
  if (data.stats && !projects && !data.stats.integrations.claude && !data.stats.integrations.codex) {
    lines.push(`  ${colors.yellow(`● ${t('dashNotConnected')}`)}`);
    lines.push(`    ${colors.dim('lattice integration claude enable · lattice integration codex enable')}`, '');
  }
  const section = (title: string, rows: string[]) =>
    lines.push(...box(title, rows, colors).map((line) => `  ${line}`), '');

  const stats = data.stats;
  const empty = projects !== undefined && projects.length === 0;
  if (stats && !empty) {
    const estimates = stats.estimates;
    const metrics = [contextRow(stats, language, colors)];
    // Tokens cover everything: `lattice run` tasks and ordinary agent sessions.
    const sent = sentTokens(stats);
    const received =
      stats.tasks.outputTokens + stats.agents.reduce((sum, group) => sum + group.outputTokens, 0);
    if (sent + received > 0 || stats.tasks.total > 0) {
      metrics.push(
        pad(t('dashTokens'), 12) +
          pad(t('dashSent', { count: tokens(sent) }), 23) +
          colors.dim(
            fit(
              estimates.prunedTokens > 0
                ? t('dashPruned', { count: tokens(estimates.prunedTokens) })
                : t('dashReceived', { count: tokens(received) }),
              INNER_WIDTH - 35,
            ),
          ),
      );
    } else {
      metrics.push(pad(t('dashTokens'), 12) + colors.dim(t('dashNoTasks')));
    }
    if (estimates.costUsd > 0 || stats.tasks.total > 0) {
      metrics.push(
        pad(t('dashEstCost'), 12) +
          pad(money(estimates.costUsd), 23) +
          (estimates.savedUsd !== null && estimates.savedUsd > 0
            ? colors.dim(fit(t('dashSavedUsd', { amount: money(estimates.savedUsd) }), INNER_WIDTH - 35))
            : ''),
      );
    }
    if (stats.tasks.total > 0) {
      const counts = [
        colors.green(`✓ ${stats.tasks.passed}`),
        colors.red(`✗ ${stats.tasks.failed}`),
        ...(stats.tasks.other > 0 ? [colors.yellow(`• ${stats.tasks.other}`)] : []),
      ].join('  ');
      metrics.push(
        pad(t('dashTasks'), 12) + pad(t('dashTasksTotal', { count: stats.tasks.total }), 23) + counts,
      );
    }
    section(t('dashMetrics'), metrics);

    if (projects) {
      const rows = projects.slice(0, MAX_PROJECT_ROWS).map((project) => {
        const pruned = project.stats.estimates.prunedTokens;
        return (
          pad(fit(project.name, 20), 21) +
          pad(taskCount(language, project.stats.tasks.total), 11) +
          colors.dim(
            fit(
              `${tokens(sentTokens(project.stats))}${pruned > 0 ? ` · ~${tokens(pruned)}` : ''}`,
              INNER_WIDTH - 32,
            ),
          )
        );
      });
      if (projects.length > MAX_PROJECT_ROWS) {
        rows.push(colors.dim(`… +${projects.length - MAX_PROJECT_ROWS}`));
      }
      section(t('dashProjects'), rows);
    }

    const sessions =
      stats.agents.length > 0
        ? stats.agents.map(
            (group) =>
              pad(agentLabel(group, language), 25) +
              pad(sessionCount(language, group.sessions), 13) +
              colors.dim(`${tokens(group.inputTokens)} · ${tokens(group.outputTokens)}`),
          )
        : [colors.dim(fit(t(projects ? 'dashNoSessionsAll' : 'dashNoSessions'), INNER_WIDTH))];
    section(t('dashSessions'), sessions);
    const pipeline =
      stats.recentTasks.length > 0
        ? stats.recentTasks.map((task) => pipelineRow(task, language, colors))
        : [colors.dim(t('dashNoTasks'))];
    section(t('dashPipeline'), pipeline);
  } else if (empty) {
    lines.push(`  ${colors.dim(t('dashNoProjects'))}`, '');
  }

  const state =
    stats && !empty
      ? `${colors.green('●')} ${colors.green(t('dashReady'))}`
      : `${colors.yellow('●')} ${colors.yellow(t('dashNoRepository'))}`;
  if (options.footer !== false) {
    lines.push(`  ${state}    ${colors.dim('lattice run "…"    lattice doctor    --help')}`, '');
  }
  return lines.join('\n');
}

/** Arrow keys, Enter and 1-9; Esc or Ctrl+C keeps the default. */
function chooseLanguage(terminal: Terminal, initial: Language): Promise<Language> {
  const { input, output } = terminal;
  let selected = Math.max(0, LANGUAGES.findIndex((language) => language.code === initial));
  const draw = () => {
    const lines = [
      '\x1b[2J\x1b[H',
      `${translate(LANGUAGES[selected].code, 'chooseLanguage')}\n`,
      ...LANGUAGES.map(
        (language, index) =>
          `${index === selected ? '\x1b[36m›\x1b[0m \x1b[7m' : '  '}${index + 1}  ${language.name}\x1b[0m`,
      ),
      '',
      `\x1b[2m${translate(LANGUAGES[selected].code, 'navHint')}\x1b[0m`,
    ];
    output.write(`${lines.join('\n')}\n`);
  };
  return new Promise((resolveChoice) => {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    const finish = (index: number) => {
      input.off('keypress', onKey);
      input.setRawMode?.(false);
      input.pause();
      output.write('\x1b[2J\x1b[H');
      resolveChoice(LANGUAGES[index].code);
    };
    const onKey = (text: string | undefined, key: Key | undefined) => {
      const name = key?.name ?? text;
      if ((key?.ctrl && name === 'c') || name === 'escape') return finish(selected);
      if (name === 'up') selected = (selected - 1 + LANGUAGES.length) % LANGUAGES.length;
      else if (name === 'down') selected = (selected + 1) % LANGUAGES.length;
      else if (name === 'return' || name === 'enter') return finish(selected);
      else if (text && /^[1-9]$/.test(text) && Number(text) <= LANGUAGES.length) {
        return finish(Number(text) - 1);
      } else return;
      draw();
    };
    input.on('keypress', onKey);
    draw();
  });
}

async function ask(terminal: Terminal, question: string) {
  const reader = createInterface({ input: terminal.input, output: terminal.output });
  try {
    return (await reader.question(question)).trim();
  } finally {
    reader.close();
  }
}

/** Returns false when a new version was just installed and the screen should not be drawn. */
async function offerUpdate(terminal: Terminal, cliPath: string, language: Language, env: NodeJS.ProcessEnv) {
  if (updateCheckDisabled(env)) return true;
  const result = await checkForUpdate({ env });
  if (!result.release || !result.newer) return true;
  const release = result.release;
  const write = (text: string) => terminal.output.write(`${text}\n`);
  const answer = await ask(
    terminal,
    translate(language, 'updatePrompt', { latest: release.version, current: LATTICE_VERSION }),
  );
  if (answer !== '' && !/^[yдтtsj]/i.test(answer)) {
    write(translate(language, 'updateSkipped'));
    return true;
  }
  const installation = await detectInstallation(cliPath);
  if (installation.kind === 'development-checkout') {
    write(translate(language, 'updateManual', { command: manualUpdateCommand(installation, release) }));
    return true;
  }
  write(translate(language, 'updateInstalling', { latest: release.version }));
  try {
    await installRelease(installation, release);
    write(translate(language, 'updateDone', { latest: release.version }));
    return false;
  } catch (error) {
    write(translate(language, 'updateFailed', { error: error instanceof Error ? error.message : String(error) }));
    write(manualUpdateCommand(installation, release));
    return true;
  }
}

/**
 * The numbers behind the start screen and `lattice stats`: the repository at
 * `cwd`, or every known project outside one (or with `all`).
 */
export async function dashboardData(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  all = false,
): Promise<DashboardData> {
  const repository = all ? null : await discoverRepository(cwd).catch(() => null);
  if (!repository?.safe) {
    // Outside a repository: every project Lattice knows, summed.
    const projects = collectAllProjects(env);
    const stats = combineStats(projects, env);
    return {
      stats,
      project: basename(cwd),
      branch: null,
      engine: stats.integrations.claude ? 'claude-code' : stats.integrations.codex ? 'codex' : null,
      projects,
    };
  }
  rememberRepository(repository.root, env);
  const stats = collectStats(repository.root, env);
  const branch = await execa('git', ['-C', repository.root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    reject: false,
  }).catch(() => null);
  return {
    stats,
    project: basename(repository.root),
    branch: branch?.exitCode === 0 && branch.stdout.trim() ? branch.stdout.trim() : null,
    engine: stats.integrations.claude ? 'claude-code' : stats.integrations.codex ? 'codex' : null,
  };
}

/**
 * `lattice` in a terminal: pick a language on the first start, offer a newer
 * release when one exists, then open the savings menu: the total over every
 * chat and task, and the history, where Enter opens one task's savings.
 */
export async function runStartScreen(options: {
  cliPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  terminal?: Terminal;
}) {
  const env = options.env ?? process.env;
  const terminal = options.terminal ?? { input: process.stdin, output: process.stdout };
  let language = readUserSettings(env).language;
  if (!language) {
    language = await chooseLanguage(
      terminal,
      languageFromLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en',
    );
    updateUserSettings({ language }, env);
  }
  if (!(await offerUpdate(terminal, options.cliPath, language, env))) return;
  const entries = collectHistory(env);
  // A keyboard opens the menu; otherwise the list is printed once.
  if (terminal.input.isTTY && typeof terminal.input.setRawMode === 'function') {
    await runHistoryMenu({ terminal, language, env, entries });
    return;
  }
  const color = Boolean(terminal.output.isTTY) && !env.NO_COLOR;
  terminal.output.write(
    `${renderHistoryList(entries, { view: 'list', selected: -1, offset: 0 }, language, color, 40)}\n`,
  );
}
