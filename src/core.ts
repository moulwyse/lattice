import {createHash,randomUUID} from 'node:crypto';import {appendFileSync,closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
export const uid=()=>randomUUID();
export const rawHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function safePath(root:string,path:string){if(isAbsolute(path)||path.replaceAll('\\','/').split('/').includes('..'))throw new Error(`unsafe repository path: ${path}`);const full=resolve(root,path);if(!full.startsWith(resolve(root)+sep))throw new Error(`path outside workspace: ${path}`);return full;}
function canonicalPath(path:string){const value=realpathSync.native(path);return process.platform==='win32'?value.toLowerCase():value;}
/** Resolve a repository file for reading without following a symlink/junction outside the repository. */
export function safeReadPath(root:string,path:string){const full=safePath(root,path);const repository=canonicalPath(root);const target=canonicalPath(full);if(!target.startsWith(`${repository}${sep}`)||!statSync(target).isFile())throw new Error(`repository read escapes workspace: ${path}`);return full;}
export const readJson=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8')) as T;
export function writeJson(path: string, value: unknown) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.lattice-write-${randomUUID()}.tmp`);
  let created = false;
  let descriptor: number | undefined;
  try {
    // Replace the directory entry, never truncate an existing inode: the
    // destination may have been planted as a symbolic link or hard link.
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) rmSync(temporary, { force: true });
  }
}
function ensureMetadataDirectory(root:string,path:string){mkdirSync(path,{recursive:true});if(lstatSync(path).isSymbolicLink())throw new Error(`Lattice metadata directory cannot be a symlink or junction: ${path}`);const repository=canonicalPath(root);const directory=canonicalPath(path);if(directory!==repository&&!directory.startsWith(`${repository}${sep}`))throw new Error(`Lattice metadata directory escapes workspace: ${path}`);if(!statSync(path).isDirectory())throw new Error(`invalid Lattice metadata directory: ${path}`);}
export function metadata(root:string){const repository=realpathSync.native(resolve(root));const base=join(repository,'.lattice');ensureMetadataDirectory(repository,base);for(const dir of ['index','sessions','tasks','handoffs','edit-grants','worktrees','logs','benchmarks','cache','cache/verified-patches'])ensureMetadataDirectory(repository,join(base,dir));excludeMetadataFromGit(repository);return base;}

const excludedRepositories = new Set<string>();

/**
 * Keep runtime state out of commits. `.lattice/` holds the sidecar token,
 * indexes, task results and isolated worktrees, and integrations create it
 * in any repository automatically. The per-clone `info/exclude` file is used
 * so no tracked file changes. Best effort: an unwritable Git directory never
 * blocks Lattice.
 */
function excludeMetadataFromGit(repository: string) {
  if (excludedRepositories.has(repository)) return;
  excludedRepositories.add(repository);
  try {
    addGitExcludePattern(repository, '/.lattice/', 'Lattice runtime state', [
      '.lattice',
      '.lattice/',
      '/.lattice',
    ]);
  } catch {
    // Ignoring is an optimization of safety, not a precondition for running.
  }
}

/**
 * Add `pattern` to the clone-local `info/exclude` unless it (or an
 * equivalent spelling) is already there. Returns whether a line was added.
 */
export function addGitExcludePattern(
  repository: string,
  pattern: string,
  comment: string,
  equivalents: readonly string[] = [],
) {
  const exclude = gitInfoExcludePath(repository);
  if (!exclude) return false;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const accepted = new Set([pattern, ...equivalents]);
  if (current.split(/\r?\n/).some((line) => accepted.has(line.trim()))) return false;
  mkdirSync(dirname(exclude), { recursive: true });
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(exclude, `${separator}# ${comment}\n${pattern}\n`, 'utf8');
  return true;
}

/** Remove a pattern (and its comment line) added by `addGitExcludePattern`. */
export function removeGitExcludePattern(repository: string, pattern: string, comment: string) {
  const exclude = gitInfoExcludePath(repository);
  if (!exclude || !existsSync(exclude)) return;
  const lines = readFileSync(exclude, 'utf8').split(/\r?\n/);
  const kept = lines.filter(
    (line, index) =>
      line.trim() !== pattern &&
      !(line.trim() === `# ${comment}` && lines[index + 1]?.trim() === pattern),
  );
  if (kept.length !== lines.length) writeFileSync(exclude, kept.join('\n'), 'utf8');
}

/** `info/exclude` of the repository whose top level is `repository`. */
function gitInfoExcludePath(repository: string) {
  const dotGit = join(repository, '.git');
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return join(dotGit, 'info', 'exclude');
  // Linked worktrees and submodules use a `.git` file; exclude rules live in
  // the common Git directory shared by every worktree.
  const gitDirectory = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!gitDirectory) return null;
  const directory = resolve(repository, gitDirectory);
  const commonFile = join(directory, 'commondir');
  const common = existsSync(commonFile)
    ? resolve(directory, readFileSync(commonFile, 'utf8').trim())
    : directory;
  return join(common, 'info', 'exclude');
}
export const exists=(path:string)=>existsSync(path);
