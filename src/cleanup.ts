import { rm } from 'node:fs/promises';

export type CleanupRetryOptions = {
  maxRetries?: number;
  retryDelayMs?: number;
};

/**
 * Recursive removal with Node's bounded Windows retry handling. Transient
 * EPERM/EBUSY/ENOTEMPTY failures are retried; the final failure is never
 * suppressed.
 */
export async function removeDirectoryWithRetry(
  path: string,
  options: CleanupRetryOptions = {},
) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: options.maxRetries ?? 8,
    retryDelay: options.retryDelayMs ?? 75,
  });
}
