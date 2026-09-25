import { emitKeypressEvents, type Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import {
  isLanguage,
  LANGUAGES,
  languageFromLocale,
  translate,
  type Language,
  type MessageKey,
} from './i18n.js';
import { runInheritedProcess } from './managed-process.js';
import { discoverRepository } from './repository.js';
import { collectStats, formatStats } from './stats.js';
import {
  checkForUpdate,
  detectInstallation,
  installRelease,
  manualUpdateCommand,
  updateCheckDisabled,
} from './update-check.js';
import { readUserSettings, updateUserSettings } from './user-settings.js';
import { LATTICE_VERSION } from './version.js';

type Terminal = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

type MenuItem<T> = { label: string; value: T };

/** Result of one menu screen: a chosen value, `back` (Esc) or `quit` (Q / Ctrl+C). */
type Choice<T> = { kind: 'value'; value: T } | { kind: 'back' } | { kind: 'quit' };

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const INVERSE = '\x1b[7m';

export function renderMenu(options: {
  header: string[];
  title: string;
  labels: string[];
  selected: number;
  hint: string;
}) {
  const lines = [...options.header, '', `${BOLD}${options.title}${RESET}`, ''];
  options.labels.forEach((label, index) => {
    const key = index < 9 ? `${index + 1}` : ' ';
    const text = `${key}  ${label}`;
    lines.push(index === options.selected ? `${CYAN}›${RESET} ${INVERSE}${text}${RESET}` : `  ${text}`);
  });
  lines.push('', `${DIM}${options.hint}${RESET}`);
  return lines.join('\n');
}

class Menu {
  private language: Language;
  private header: string[] = [];
  private updateLine = '';
  private repositoryRoot: string | null = null;

  constructor(
    private readonly terminal: Terminal,
    private readonly cliPath: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.language = readUserSettings(env).language ?? 'en';
  }

  private t(key: MessageKey, values?: Record<string, string | number>) {
    return translate(this.language, key, values);
  }

  private write(text: string) {
    this.terminal.output.write(text);
  }

  private clear() {
    this.write('\x1b[2J\x1b[3J\x1b[H');
  }

  private refreshHeader() {
    const version = `${BOLD}Lattice${RESET} ${this.t('version', { version: LATTICE_VERSION })}`;
    this.header = [
      this.updateLine ? `${version}  ${DIM}·${RESET}  ${this.updateLine}` : version,
      this.repositoryRoot
        ? `${DIM}${this.t('repository', { path: this.repositoryRoot })}${RESET}`
        : `${DIM}${this.t('noRepository')}${RESET}`,
    ];
  }

  /** Arrow keys, Enter, 1-9 shortcuts, Esc for back and Q or Ctrl+C to quit. */
  private select<T>(title: string, items: MenuItem<T>[], initial = 0): Promise<Choice<T>> {
    const { input } = this.terminal;
    let selected = Math.min(Math.max(initial, 0), items.length - 1);
    const draw = () => {
      this.clear();
      this.write(
        `${renderMenu({
          header: this.header,
          title,
          labels: items.map((item) => item.label),
          selected,
          hint: this.t('navHint'),
        })}\n`,
      );
    };
    return new Promise((resolveChoice) => {
      emitKeypressEvents(input);
      input.setRawMode?.(true);
      input.resume();
      const finish = (choice: Choice<T>) => {
        input.off('keypress', onKey);
        input.setRawMode?.(false);
        input.pause();
        resolveChoice(choice);
      };
      const onKey = (text: string | undefined, key: Key | undefined) => {
        const name = key?.name ?? text;
        if ((key?.ctrl && name === 'c') || name === 'q') return finish({ kind: 'quit' });
        if (name === 'escape' || name === 'backspace' || name === 'left') {
          return finish({ kind: 'back' });
        }
        if (name === 'up' || name === 'k') selected = (selected - 1 + items.length) % items.length;
        else if (name === 'down' || name === 'j') selected = (selected + 1) % items.length;
        else if (name === 'home') selected = 0;
        else if (name === 'end') selected = items.length - 1;
        else if (name === 'return' || name === 'enter' || name === 'right') {
          return finish({ kind: 'value', value: items[selected].value });
        } else if (text && /^[1-9]$/.test(text) && Number(text) <= items.length) {
          return finish({ kind: 'value', value: items[Number(text) - 1].value });
        } else return;
        draw();
      };
      input.on('keypress', onKey);
      draw();
    });
  }

  private async ask(question: string) {
    const reader = createInterface({ input: this.terminal.input, output: this.terminal.output });
    try {
      return (await reader.question(question)).trim();
    } finally {
      reader.close();
    }
  }

  private async pause() {
    await this.ask(`\n${DIM}${this.t('pressEnter')}${RESET} `);
  }

  private async runCli(args: string[]) {
    this.clear();
    // Ctrl+C belongs to the child (for example a running agent), not the menu.
    await runInheritedProcess(process.execPath, [this.cliPath, ...args], {
      cwd: this.cwd,
      env: this.env,
      ignoreSignals: ['SIGINT'],
    });
  }

  private async chooseLanguage(first: boolean) {
    const suggested = first
      ? (languageFromLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en')
      : this.language;
    const choice = await this.select(
      `${this.t('chooseLanguage')}${this.language === 'en' ? '' : ' / Choose your language'}`,
      LANGUAGES.map((language) => ({ label: language.name, value: language.code })),
      LANGUAGES.findIndex((language) => language.code === suggested),
    );
    if (choice.kind !== 'value' || !isLanguage(choice.value)) return choice.kind !== 'quit';
    this.language = choice.value;
    updateUserSettings({ language: choice.value }, this.env);
    this.refreshHeader();
    return true;
  }

  /** Returns false when the menu should close because a new version was installed. */
  private async checkUpdates(interactive: boolean) {
    if (!interactive && updateCheckDisabled(this.env)) return true;
    const result = await checkForUpdate({ env: this.env });
    if (!result.release) {
      this.updateLine = `${DIM}${this.t('updateUnknown')}${RESET}`;
    } else if (!result.newer) {
      this.updateLine = `${DIM}${this.t('upToDate')}${RESET}`;
    } else {
      this.updateLine = `${CYAN}${this.t('updateAvailable', { latest: result.release.version })}${RESET}`;
    }
    this.refreshHeader();
    if (!result.release || !result.newer) {
      if (interactive) {
        this.clear();
        this.write(
          `${result.release ? this.t('updateNone', { current: LATTICE_VERSION }) : this.t('updateUnknown')}\n`,
        );
        await this.pause();
      }
      return true;
    }
    this.clear();
    this.write(`${this.header.join('\n')}\n\n`);
    const answer = await this.ask(
      this.t('updatePrompt', { latest: result.release.version, current: LATTICE_VERSION }),
    );
    if (answer !== '' && !/^[yдтtsj]/i.test(answer)) {
      this.write(`${this.t('updateSkipped')}\n`);
      if (interactive) await this.pause();
      return true;
    }
    const installation = await detectInstallation(this.cliPath);
    if (installation.kind === 'development-checkout') {
      this.write(`\n${this.t('updateManual', { command: manualUpdateCommand(installation, result.release) })}\n`);
      await this.pause();
      return true;
    }
    this.write(`\n${this.t('updateInstalling', { latest: result.release.version })}\n\n`);
    try {
      await installRelease(installation, result.release);
      this.write(`\n${this.t('updateDone', { latest: result.release.version })}\n`);
      return false;
    } catch (error) {
      this.write(
        `\n${this.t('updateFailed', { error: error instanceof Error ? error.message : String(error) })}\n` +
          `${manualUpdateCommand(installation, result.release)}\n`,
      );
      await this.pause();
      return true;
    }
  }

  private async runTask() {
    this.clear();
    this.write(`${this.header.join('\n')}\n\n`);
    const goal = await this.ask(this.t('taskPrompt'));
    if (!goal) return;
    const worker = await this.select(this.t('chooseWorker'), [
      { label: this.t('workerCodex'), value: 'codex' },
      { label: this.t('workerClaude'), value: 'claude' },
    ]);
    if (worker.kind !== 'value') return;
    const apply = await this.select(this.t('applyTitle'), [
      { label: this.t('applyYes'), value: true },
      { label: this.t('applyNo'), value: false },
    ]);
    if (apply.kind !== 'value') return;
    await this.runCli(['run', goal, '--worker', worker.value, ...(apply.value ? [] : ['--no-apply'])]);
    await this.pause();
  }

  private async showStats() {
    this.clear();
    this.write(
      this.repositoryRoot
        ? `${formatStats(collectStats(this.repositoryRoot, this.env), this.language)}\n`
        : `${this.t('noRepository')}\n`,
    );
    await this.pause();
  }

  private async submenu(title: string, items: MenuItem<string[]>[]) {
    for (let last = 0; ; ) {
      const choice = await this.select(title, [
        ...items,
        { label: this.t('back'), value: [] as string[] },
      ], last);
      if (choice.kind === 'quit') return false;
      if (choice.kind === 'back' || choice.value.length === 0) return true;
      last = items.findIndex((item) => item.value === choice.value);
      await this.runCli(choice.value);
      await this.pause();
    }
  }

  async run() {
    if (!readUserSettings(this.env).language) {
      if (!(await this.chooseLanguage(true))) return;
    }
    const repository = await discoverRepository(this.cwd).catch(() => null);
    this.repositoryRoot = repository?.safe ? repository.root : null;
    this.refreshHeader();
    if (!(await this.checkUpdates(false))) return;

    type Action =
      | 'run' | 'stats' | 'claude' | 'codex' | 'integrations' | 'doctor'
      | 'selftest' | 'sessions' | 'updates' | 'language' | 'about' | 'exit';
    const workspace = this.repositoryRoot ?? this.cwd;
    for (let last = 0; ; ) {
      const items: MenuItem<Action>[] = [
        { label: this.t('runTask'), value: 'run' },
        { label: this.t('stats'), value: 'stats' },
        { label: this.t('launchClaude'), value: 'claude' },
        { label: this.t('launchCodex'), value: 'codex' },
        { label: this.t('integrations'), value: 'integrations' },
        { label: this.t('doctor'), value: 'doctor' },
        { label: this.t('selfTest'), value: 'selftest' },
        { label: this.t('sessions'), value: 'sessions' },
        { label: this.t('checkUpdates'), value: 'updates' },
        { label: this.t('language'), value: 'language' },
        { label: this.t('about'), value: 'about' },
        { label: this.t('exit'), value: 'exit' },
      ];
      const choice = await this.select(this.t('mainTitle'), items, last);
      if (choice.kind !== 'value' || choice.value === 'exit') break;
      last = items.findIndex((item) => item.value === choice.value);
      switch (choice.value) {
        case 'run':
          await this.runTask();
          break;
        case 'stats':
          await this.showStats();
          break;
        case 'claude':
          await this.runCli(['claude']);
          break;
        case 'codex':
          await this.runCli(['codex']);
          break;
        case 'integrations':
          if (
            !(await this.submenu(this.t('integrationsTitle'), [
              { label: this.t('claudeStatus'), value: ['integration', 'claude', 'status', '--workspace', workspace] },
              { label: this.t('claudeEnable'), value: ['integration', 'claude', 'enable', '--workspace', workspace] },
              { label: this.t('claudeDisable'), value: ['integration', 'claude', 'disable', '--workspace', workspace] },
              { label: this.t('codexStatus'), value: ['integration', 'codex', 'status', '--workspace', workspace] },
              { label: this.t('codexDoctor'), value: ['integration', 'codex', 'doctor', '--workspace', workspace] },
              { label: this.t('codexEnable'), value: ['integration', 'codex', 'enable'] },
              { label: this.t('codexDisable'), value: ['integration', 'codex', 'disable'] },
            ]))
          ) {
            return;
          }
          break;
        case 'doctor':
          await this.runCli(['doctor', '--workspace', workspace]);
          await this.pause();
          break;
        case 'selftest':
          await this.runCli(['benchmark', '--worker', 'mock']);
          await this.pause();
          break;
        case 'sessions':
          if (
            !(await this.submenu(this.t('sessionsTitle'), [
              { label: this.t('sessionsList'), value: ['session', 'show', '--workspace', workspace] },
              { label: this.t('sessionsNew'), value: ['session', 'new', '--workspace', workspace] },
            ]))
          ) {
            return;
          }
          break;
        case 'updates':
          if (!(await this.checkUpdates(true))) return;
          break;
        case 'language':
          if (!(await this.chooseLanguage(false))) return;
          break;
        case 'about':
          await this.runCli(['--about']);
          await this.pause();
          break;
      }
    }
    this.clear();
  }
}

export async function runMenu(options: {
  cliPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  terminal?: Terminal;
}) {
  const terminal = options.terminal ?? { input: process.stdin, output: process.stdout };
  await new Menu(terminal, options.cliPath, options.cwd ?? process.cwd(), options.env ?? process.env).run();
}
