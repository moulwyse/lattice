import { basename } from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { execa } from 'execa';
import { fileCount, LANGUAGES, languageFromLocale, translate, type Language } from './i18n.js';
import { discoverRepository } from './repository.js';
import { collectStats, formatBytes, type LatticeStats, type RecentTask } from './stats.js';
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
  const sizes = pad(`${formatBytes(average, language)} / ${formatBytes(stats.index.bytes, language)}`, 21);
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
  const head = `${mark} ${pad(fit(task.name, 18), 19)}${pad(fileCount(language, task.files), 11)}`;
  const room = INNER_WIDTH - 32;
  if (task.status === 'passed') {
    const time = task.verificationMs === null ? '—' : seconds(task.verificationMs);
    return head + colors.dim(fit(translate(language, 'dashVerified', { time }), room));
  }
  const detail = translate(language, 'dashFailed', { reason: task.reason ?? '—' });
  return head + (task.status === 'failed' ? colors.red(fit(detail, room)) : colors.dim(fit(detail, room)));
}

export function renderDashboard(data: DashboardData, language: Language, color: boolean) {
  const colors = palette(color);
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(language, key, values);
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const lines = ['', ...renderLogo(color).map((line) => `  ${line}`), ''];
  const status = [
    `v${LATTICE_VERSION}`,
    data.project,
    ...(data.branch ? [`git:${data.branch}`] : []),
    `engine:${data.engine ?? t('dashNone')}`,
  ].join(' · ');
  lines.push(`  ${colors.dim(status)}`, '');

  const stats = data.stats;
  if (stats) {
    const metrics = [contextRow(stats, language, colors)];
    if (stats.tasks.total > 0) {
      const money = new Intl.NumberFormat(language, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 3,
      }).format(stats.tasks.costUsd);
      metrics.push(
        pad(t('dashTokens'), 12) +
          pad(t('dashSent', { count: number(stats.tasks.inputTokens) }), 21) +
          colors.dim(t('dashReceived', { count: number(stats.tasks.outputTokens) })),
        pad(t('dashCost'), 12) + pad(money, 21) + colors.dim(t('dashProviderReported')),
      );
    } else {
      metrics.push(pad(t('dashTokens'), 12) + colors.dim(t('dashNoTasks')));
    }
    lines.push(...box(t('dashMetrics'), metrics, colors).map((line) => `  ${line}`), '');
    const pipeline =
      stats.recentTasks.length > 0
        ? stats.recentTasks.map((task) => pipelineRow(task, language, colors))
        : [colors.dim(t('dashNoTasks'))];
    lines.push(...box(t('dashPipeline'), pipeline, colors).map((line) => `  ${line}`), '');
  }

  const state = stats
    ? `${colors.green('●')} ${colors.green(t('dashReady'))}`
    : `${colors.yellow('●')} ${colors.yellow(t('dashNoRepository'))}`;
  lines.push(`  ${state}    ${colors.dim('lattice run "…"    lattice doctor    --help')}`, '');
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

async function dashboardData(cwd: string, env: NodeJS.ProcessEnv): Promise<DashboardData> {
  const repository = await discoverRepository(cwd).catch(() => null);
  if (!repository?.safe) {
    return { stats: null, project: basename(cwd), branch: null, engine: null };
  }
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
 * release when one exists, then print the start screen.
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
  const data = await dashboardData(options.cwd ?? process.cwd(), env);
  const color = Boolean(terminal.output.isTTY) && !env.NO_COLOR;
  terminal.output.write(`${renderDashboard(data, language, color)}\n`);
}
