import { discoverRepository } from './repository.js';
import {
  sidecarStatus,
  startSidecarServer,
  stopSidecar,
} from './sidecar.js';

export async function runSidecarCommand(
  workspace: string,
  options: { foreground: boolean; persistent?: boolean },
) {
  const repository = await discoverRepository(workspace);
  if (!repository.safe) {
    throw new Error(`no safe repository detected: ${repository.reason}`);
  }
  const server = await startSidecarServer(repository.root, {
    foreground: options.foreground,
    idleShutdownMs: options.persistent ? Number.POSITIVE_INFINITY : undefined,
  });
  if (options.foreground) {
    console.error(
      `Lattice sidecar ready for ${repository.root} (pid ${server.state().pid})`,
    );
  }
  const close = () => void server.close();
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.once('SIGHUP', close);
  try {
    await server.closed;
  } finally {
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
    process.removeListener('SIGHUP', close);
    await server.close();
  }
}

export async function inspectSidecarCommand(workspace: string) {
  const repository = await discoverRepository(workspace);
  if (!repository.safe) {
    return {
      repository,
      sidecar: {
        running: false as const,
        state: null,
      },
    };
  }
  return {
    repository,
    sidecar: await sidecarStatus(repository.root),
  };
}

export async function stopSidecarCommand(workspace: string) {
  const repository = await discoverRepository(workspace);
  if (!repository.safe) {
    throw new Error(`no safe repository detected: ${repository.reason}`);
  }
  return stopSidecar(repository.root);
}

