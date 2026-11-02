import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { execa } from 'execa';
import { runInheritedProcess } from './managed-process.js';
import { updateUserSettings } from './user-settings.js';
import { LATTICE_VERSION } from './version.js';

export const LATEST_RELEASE_URL =
  'https://api.github.com/repos/moulwyse/lattice/releases/latest';

export type LatestRelease = {
  version: string;
  tag: string;
  packageUrl: string | null;
};

/** Compare dotted numeric versions such as `2.1.0` and `v2.10.1`. */
export function compareVersions(left: string, right: string) {
  const parse = (value: string) =>
    value.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env) {
  return env.LATTICE_NO_UPDATE_CHECK === '1' || env.CI === 'true';
}

/**
 * Ask GitHub for the latest release. Returns null on any network, timeout or
 * format problem: a failed check must never block the menu.
 */
export async function fetchLatestRelease(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LatestRelease | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `lattice-cli/${LATTICE_VERSION}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      tag_name?: unknown;
      assets?: { name?: unknown; browser_download_url?: unknown }[];
    };
    if (typeof body.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+/.test(body.tag_name)) {
      return null;
    }
    const asset = (body.assets ?? []).find(
      (entry) =>
        typeof entry.name === 'string' &&
        entry.name.endsWith('.tgz') &&
        typeof entry.browser_download_url === 'string' &&
        entry.browser_download_url.startsWith('https://github.com/moulwyse/lattice/'),
    );
    return {
      version: body.tag_name.replace(/^v/, ''),
      tag: body.tag_name,
      packageUrl: (asset?.browser_download_url as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/** Check GitHub and remember the answer for `lattice stats` and the MCP tool. */
export async function checkForUpdate(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const release = await fetchLatestRelease(options);
  if (release) {
    updateUserSettings(
      {
        lastUpdateCheck: {
          checkedAt: new Date().toISOString(),
          latestVersion: release.version,
        },
      },
      options.env,
    );
  }
  return {
    current: LATTICE_VERSION,
    release,
    newer: release !== null && compareVersions(release.version, LATTICE_VERSION) > 0,
  };
}

export type Installation =
  | { kind: 'npm-package' }
  | { kind: 'release-checkout'; root: string }
  | { kind: 'development-checkout'; root: string };

/** The Lattice root that contains the running `dist/cli.js`. */
export function packageRoot(cliPath: string) {
  return resolve(dirname(cliPath), '..');
}

/**
 * How this copy of Lattice was installed decides how it can be updated:
 * a global npm package is reinstalled from the release asset; a checkout made
 * by the installers sits on a detached release tag and moves to the new tag;
 * any other checkout belongs to a developer and is never changed for them.
 */
export async function detectInstallation(cliPath: string): Promise<Installation> {
  const root = packageRoot(cliPath);
  if (root.split(sep).includes('node_modules') || !existsSync(join(root, '.git'))) {
    return { kind: 'npm-package' };
  }
  const branch = await execa('git', ['-C', root, 'symbolic-ref', '-q', 'HEAD'], {
    reject: false,
  });
  const status = await execa('git', ['-C', root, 'status', '--porcelain'], { reject: false });
  const detachedAndClean =
    branch.exitCode !== 0 && status.exitCode === 0 && status.stdout.trim() === '';
  return detachedAndClean
    ? { kind: 'release-checkout', root }
    : { kind: 'development-checkout', root };
}

export function manualUpdateCommand(installation: Installation, release: LatestRelease) {
  return installation.kind === 'development-checkout'
    ? `git -C "${installation.root}" fetch --tags && git -C "${installation.root}" checkout ${release.tag} && npm run build`
    : `npm install --global ${release.packageUrl ?? `https://github.com/moulwyse/lattice/releases/tag/${release.tag}`}`;
}

async function step(command: string, args: string[], cwd?: string) {
  const result = await runInheritedProcess(command, args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.exitCode ?? result.signal}`);
  }
}

/** Install `release` in place. Output goes straight to the user's terminal. */
export async function installRelease(installation: Installation, release: LatestRelease) {
  if (installation.kind === 'development-checkout') {
    throw new Error('development checkouts are updated manually');
  }
  if (installation.kind === 'npm-package') {
    if (!release.packageUrl) throw new Error(`release ${release.tag} has no package file`);
    await step('npm', ['install', '--global', release.packageUrl]);
    return;
  }
  const { root } = installation;
  await step('git', ['-C', root, 'fetch', '--tags', '--force', 'origin']);
  await step('git', ['-C', root, 'checkout', '--detach', release.tag]);
  try {
    await step('npm', ['ci'], root);
  } catch {
    await step('npm', ['install'], root);
  }
  await step('npm', ['run', 'build'], root);
}
