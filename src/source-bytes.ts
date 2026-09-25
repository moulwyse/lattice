import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Current size of the distinct repository files behind the served pages: what
 * an agent reading those files whole would have received. Paths outside the
 * repository and unreadable files count as zero.
 */
export function sourceFileBytes(repositoryRoot: string, paths: readonly string[]) {
  let root: string;
  try {
    root = realpathSync.native(repositoryRoot);
  } catch {
    return 0;
  }
  let total = 0;
  for (const path of new Set(paths)) {
    try {
      const file = realpathSync.native(resolve(root, path));
      if (!file.startsWith(`${root}${sep}`)) continue;
      const stat = statSync(file);
      if (stat.isFile()) total += stat.size;
    } catch {
      // A file deleted since indexing simply has nothing to compare against.
    }
  }
  return total;
}
