import { emitKeypressEvents, type Key } from 'node:readline';
import { renderLogo } from './dashboard.js';
import { collectHistory, historyTotals, type HistoryEntry, type HistoryTotals } from './history.js';
import { translate, type Language, type MessageKey } from './i18n.js';
import { agentLabel, formatBytes } from './stats.js';
import { LATTICE_VERSION } from './version.js';

type Terminal = { input: NodeJS.ReadStream; output: NodeJS.WriteStream };

const INNER_WIDTH = 64;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const visible = (value: string) => [...value.replace(ANSI, '')].length;

function fit(value: string, width: number) {
  const characters = [...value];
  return characters.length <= width
    ? value
    : `${characters.slice(0, Math.max(0, width - 1)).join('').trimEnd()}…`;
}

function pad(value: string, width: number) {
  return value + ' '.repeat(Math.max(0, width - visible(value)));
}

function padStart(value: string, width: number) {
  return ' '.repeat(Math.max(0, width - visible(value))) + value;
}

type Colors = Record<'dim' | 'bold' | 'green' | 'red' | 'yellow' | 'border' | 'inverse', (value: string) => string>;

function palette(color: boolean): Colors {
  const wrap = (code: string) => (value: string) => (color && value ? `\x1b[${code}m${value}\x1b[0m` : value);
  return {
    dim: wrap('38;2;128;134;145'),
    bold: wrap('1;38;2;236;239;244'),
    green: wrap('38;2;63;185;80'),
    red: wrap('38;2;248;81;73'),
    yellow: wrap('38;2;210;153;34'),
    border: wrap('38;2;110;118;129'),
    inverse: wrap('7'),
  };
}

function box(title: string, rows: string[], colors: Colors) {
  const top = `${colors.border('┌─')} ${colors.bold(title)} ${colors.border(`${'─'.repeat(Math.max(0, INNER_WIDTH - visible(title) - 1))}┐`)}`;
  const body = rows.map((row) => `${colors.border('│')} ${pad(fit(row, INNER_WIDTH), INNER_WIDTH)} ${colors.border('│')}`);
  return [top, ...body, colors.border(`└${'─'.repeat(INNER_WIDTH + 2)}┘`)].map((line) => `  ${line}`);
}

/** Wraps plain text to lines of at most `width` characters. */
function wrap(text: string, width: number, maxLines: number) {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && visible(`${current} ${word}`) > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = fit(`${lines[maxLines - 1]} …`, width);
  }
  return lines.map((line) => fit(line, width));
}

function formatters(language: Language) {
  const t = (key: MessageKey, values?: Record<string, string | number>) => translate(language, key, values);
  const count = (value: number) =>
    new Intl.NumberFormat(language, {
      notation: value >= 100_000 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(value);
  const exact = (value: number) => new Intl.NumberFormat(language).format(value);
  const usd = (value: number) =>
    new Intl.NumberFormat(language, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: value >= 100 ? 0 : value >= 1 ? 2 : 3,
    }).format(value);
  const percent = (value: number) =>
    new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: value < 0.1 ? 1 : 0 }).format(value);
  // `25.09 23:35` in every language, so the column stays eleven wide.
  const short = (value: string) => {
    const date = new Date(value);
    const two = (part: number) => String(part).padStart(2, '0');
    return `${two(date.getDate())}.${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
  };
  const long = (value: string) =>
    new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const time = (value: string) =>
    new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const minutes = (from: string, to: string) =>
    new Intl.NumberFormat(language, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(
      Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000)),
    );
  const seconds = (milliseconds: number) =>
    new Intl.NumberFormat(language, {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'narrow',
      maximumFractionDigits: 1,
    }).format(milliseconds / 1000);
  return { t, count, exact, usd, percent, short, long, time, minutes, seconds };
}

const usedLattice = (entry: HistoryEntry) => entry.lattice.calls > 0 || entry.lattice.pages > 0;

function totalsBox(totals: HistoryTotals, language: Language, colors: Colors) {
  const { t, count, usd, percent } = formatters(language);
  const label = (key: MessageKey) => pad(t(key), 14);
  const rows = [
    label('menuSaved') +
      pad(colors.green(t('menuSavedValue', { tokens: count(totals.savedTokens) })), 24) +
      (totals.savedUsd > 0 ? colors.dim(t('menuEstimate', { amount: usd(totals.savedUsd) })) : ''),
    label('menuContext') +
      (totals.fileBytes > 0
        ? t('menuContextOf', {
            size: formatBytes(totals.sentBytes, language),
            whole: formatBytes(totals.fileBytes, language),
            share: percent(totals.sentBytes / totals.fileBytes),
          })
        : t('menuContextValue', { size: formatBytes(totals.sentBytes, language) })),
    label('menuWithLattice') + t('menuWithLatticeValue', { count: totals.withLattice, total: totals.entries }),
    label('menuSpent') +
      pad(t('menuTokensValue', { tokens: count(totals.inputTokens + totals.outputTokens) }), 24) +
      (totals.costUsd > 0 ? colors.dim(t('menuEstimate', { amount: usd(totals.costUsd) })) : ''),
  ];
  return box(t('menuSavings'), rows, colors);
}

function historyRow(entry: HistoryEntry, position: number, selected: boolean, language: Language, colors: Colors) {
  const { count, usd, short } = formatters(language);
  const mark =
    entry.kind === 'task'
      ? entry.status === 'passed'
        ? colors.green('✓ ')
        : entry.status === 'failed'
          ? colors.red('✗ ')
          : colors.yellow('• ')
      : '';
  const saved = usedLattice(entry)
    ? padStart(colors.green(`≈${count(entry.savedTokens)}`), 8)
    : padStart(colors.dim('—'), 8);
  const money = padStart(entry.savedUsd && entry.savedUsd > 0 ? colors.dim(usd(entry.savedUsd)) : '', 9);
  const titleWidth = INNER_WIDTH - 4 - 12 - 11 - 17 - 1;
  // The number is what `lattice history <number>` opens.
  const number = pad(`${selected ? '›' : ''}${position}`, 4);
  const row =
    `${number}${pad(short(entry.endedAt), 12)}${pad(fit(entry.project, 10), 11)}` +
    `${pad(mark + fit(entry.title, titleWidth - (mark ? 2 : 0)), titleWidth)} ${saved}${money}`;
  return selected ? colors.inverse(row.replace(ANSI, '')) : row;
}

/** History rows that fit: the header (with the logo from 44 rows), totals and hints take the rest. */
function historyRoom(height: number) {
  const header = height >= 44 ? 12 : 3;
  return Math.max(3, height - header - 7 - 5);
}

export type MenuState = { view: 'list' | 'detail'; selected: number; offset: number };

/** The list screen: totals and a scrolling window of the history. */
export function renderHistoryList(
  entries: HistoryEntry[],
  state: MenuState,
  language: Language,
  color: boolean,
  height = 40,
) {
  const colors = palette(color);
  const { t } = formatters(language);
  const status = colors.dim(`v${LATTICE_VERSION} · ${t('menuAllProjects')}`);
  // The logo takes nine rows; short terminals keep them for the history.
  const lines =
    height >= 44
      ? ['', ...renderLogo(color).map((line) => `  ${line}`), '', `  ${status}`, '']
      : ['', `  ${colors.bold('LATTICE')}  ${status}`, ''];
  lines.push(...totalsBox(historyTotals(entries), language, colors), '');
  const room = historyRoom(height);
  const rows =
    entries.length === 0
      ? [colors.dim(t('menuEmpty'))]
      : entries
          .slice(state.offset, state.offset + room)
          .map((entry, index) =>
            historyRow(entry, state.offset + index + 1, state.offset + index === state.selected, language, colors),
          );
  if (entries.length > room) {
    rows.push(colors.dim(`${state.offset + 1}–${Math.min(entries.length, state.offset + room)} / ${entries.length}`));
  }
  lines.push(...box(t('menuHistory', { count: entries.length }), rows, colors), '');
  lines.push(`  ${colors.dim(t('menuHint'))}`, '');
  return lines.join('\n');
}

/** The card of one task: where and when, its savings and what it spent. */
export function renderHistoryDetail(entry: HistoryEntry, language: Language, color: boolean) {
  const colors = palette(color);
  const { t, exact, usd, percent, long, time, minutes, seconds } = formatters(language);
  const label = (key: MessageKey) => pad(t(key), 20);
  const where =
    entry.kind === 'task'
      ? `${t('menuLatticeRun')} · ${
          entry.status === 'passed'
            ? colors.green(`✓ ${t('menuStatusPassed')}`)
            : entry.status === 'failed'
              ? colors.red(`✗ ${t('menuStatusFailed')}`)
              : colors.yellow(`• ${t('menuStatusOther')}`)
        }`
      : agentLabel({ agent: entry.agent as 'claude-code' | 'codex', surface: entry.surface ?? 'other' }, language);
  const sameDay = entry.startedAt.slice(0, 10) === entry.endedAt.slice(0, 10);
  const task = [
    ...wrap(entry.title, INNER_WIDTH, 3).map((line) => colors.bold(line)),
    '',
    label('menuProject') + fit(entry.project, INNER_WIDTH - 20),
    label('menuWhere') + where,
    label('menuWhen') +
      `${long(entry.startedAt)} → ${sameDay ? time(entry.endedAt) : long(entry.endedAt)} (${minutes(entry.startedAt, entry.endedAt)})`,
    label('menuModel') + (entry.model ?? t('menuUnknown')),
  ];

  const savings: string[] = [];
  if (!usedLattice(entry)) {
    savings.push(colors.yellow(t('menuNoLattice')));
  } else {
    savings.push(
      label(entry.kind === 'task' ? 'menuPages' : 'menuRequests') +
        (entry.kind === 'task'
          ? exact(entry.lattice.pages)
          : t('menuRequestsValue', {
              calls: exact(entry.lattice.calls),
              pages: exact(entry.lattice.pages),
              files: exact(entry.lattice.files),
            })),
      label('menuSent') + formatBytes(entry.lattice.sentBytes, language),
    );
    if (entry.lattice.fileBytes > 0) {
      savings.push(
        label('menuWhole') + formatBytes(entry.lattice.fileBytes, language),
        label('menuSaved') +
          colors.green(
            t('menuSavedDetail', {
              size: formatBytes(entry.lattice.savedBytes, language),
              tokens: exact(entry.savedTokens),
              share: percent(entry.lattice.savedBytes / entry.lattice.fileBytes),
            }),
          ),
        label('menuInMoney') +
          (entry.savedUsd === null ? colors.dim(t('menuUnknown')) : t('menuInMoneyValue', { amount: usd(entry.savedUsd) })),
      );
    } else {
      savings.push(colors.dim(t('menuNoBaseline')));
    }
  }

  const spending = [
    label('menuTokensIn') +
      t('menuTokensInValue', { input: exact(entry.tokens.input), cached: exact(entry.tokens.cached) }),
    label('menuTokensOut') + exact(entry.tokens.output),
    label('menuCost') +
      (entry.costUsd === null
        ? colors.dim(t('menuUnknown'))
        : t(entry.kind === 'task' ? 'menuCostProvider' : 'menuEstimate', { amount: usd(entry.costUsd) })),
  ];
  if (entry.kind === 'task') {
    spending.push(label('menuChanged') + exact(entry.changedFiles ?? 0));
    if (entry.verificationMs !== null) spending.push(label('menuVerification') + seconds(entry.verificationMs));
    if (entry.reason) spending.push(label('menuError') + colors.red(fit(entry.reason, INNER_WIDTH - 20)));
  }

  return [
    '',
    ...box(t('menuTask'), task, colors),
    '',
    ...box(t('menuSavings'), savings, colors),
    '',
    ...box(t('menuSpending'), spending, colors),
    '',
    `  ${colors.dim(t('menuDetailHint'))}`,
    '',
  ].join('\n');
}

/**
 * The interactive history: ↑/↓ (PgUp/PgDn, Home/End) move, Enter opens a
 * task, Esc/←/Backspace goes back, q or Ctrl+C quits. Resolves on quit.
 */
export function runHistoryMenu(options: {
  terminal: Terminal;
  language: Language;
  env?: NodeJS.ProcessEnv;
  entries?: HistoryEntry[];
}): Promise<void> {
  const { terminal, language } = options;
  const { input, output } = terminal;
  const env = options.env ?? process.env;
  const entries = options.entries ?? collectHistory(env);
  const color = Boolean(output.isTTY) && !env.NO_COLOR;
  const state: MenuState = { view: 'list', selected: 0, offset: 0 };
  const height = () => output.rows || 40;
  const listRoom = () => historyRoom(height());
  const draw = () => {
    const screen =
      state.view === 'detail' && entries[state.selected]
        ? renderHistoryDetail(entries[state.selected], language, color)
        : renderHistoryList(entries, state, language, color, height());
    output.write(`\x1b[2J\x1b[H${screen}\n`);
  };
  const move = (delta: number) => {
    if (entries.length === 0) return;
    state.selected = Math.min(entries.length - 1, Math.max(0, state.selected + delta));
    const room = listRoom();
    if (state.selected < state.offset) state.offset = state.selected;
    if (state.selected >= state.offset + room) state.offset = state.selected - room + 1;
  };
  return new Promise((resolveMenu) => {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    const finish = () => {
      input.off('keypress', onKey);
      input.setRawMode?.(false);
      input.pause();
      resolveMenu();
    };
    const onKey = (text: string | undefined, key: Key | undefined) => {
      const name = key?.name ?? text;
      if ((key?.ctrl && name === 'c') || name === 'q') return finish();
      if (state.view === 'detail') {
        if (name === 'escape' || name === 'left' || name === 'backspace') state.view = 'list';
        else if (name === 'up') move(-1);
        else if (name === 'down') move(1);
        else return;
      } else {
        if (name === 'escape') return finish();
        if (name === 'up') move(-1);
        else if (name === 'down') move(1);
        else if (name === 'pageup') move(-listRoom());
        else if (name === 'pagedown') move(listRoom());
        else if (name === 'home') move(-entries.length);
        else if (name === 'end') move(entries.length);
        else if ((name === 'return' || name === 'enter' || name === 'right') && entries.length > 0) state.view = 'detail';
        else return;
      }
      draw();
    };
    input.on('keypress', onKey);
    draw();
  });
}
