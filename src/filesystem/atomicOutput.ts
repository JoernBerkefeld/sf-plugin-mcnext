import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type AtomicOutputFile = {
  path: string;
  handle: FileHandle;
};

export type AtomicOutputFilesystem = {
  mkdir: typeof mkdir;
  lstat: typeof lstat;
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
  chmod: typeof chmod;
};

export type AtomicOutputOptions = {
  filesystem?: AtomicOutputFilesystem;
  createId?: () => string;
};

/** Reports that automatic restoration failed while retaining the original at a known recovery path. */
export class AtomicOutputRecoveryError extends AggregateError {
  public constructor(
    errors: Iterable<unknown>,
    public readonly destination: string,
    public readonly backupPath: string,
    public readonly destinationStatus: string
  ) {
    super(
      errors,
      `Atomic output restoration failed. Destination ${destinationStatus}. Original retained at backup path: ${backupPath}`
    );
    this.name = 'AtomicOutputRecoveryError';
  }
}

const defaultFilesystem: AtomicOutputFilesystem = { mkdir, lstat, open, rename, unlink, chmod };

/**
 * Writes a destination through a unique sibling staging file and replaces the destination only after the writer succeeds.
 * The writer owns fully writing and closing the supplied handle; the helper also closes it defensively before commit.
 *
 * When a destination already exists, it is first moved to a unique sibling backup. A failed final rename normally
 * restores that backup before the error is reported. If restoration is impossible, AtomicOutputRecoveryError identifies
 * the destination state and exact retained backup path. Cleanup is limited to paths created by this invocation.
 */
// eslint-disable-next-line complexity -- transactional commit and rollback states are intentionally explicit
export async function writeAtomicOutput<T>(
  destination: string,
  writer: (output: AtomicOutputFile) => Promise<T>,
  options: AtomicOutputOptions = {}
): Promise<T> {
  const filesystem = options.filesystem ?? defaultFilesystem;
  const createId = options.createId ?? randomUUID;
  const parent = dirname(destination);
  const destinationName = basename(destination);

  await filesystem.mkdir(parent, { recursive: true });

  const stagingPath = join(parent, `.${destinationName}.${createId()}.stage`);
  const backupPath = join(parent, `.${destinationName}.${createId()}.backup`);
  let stagingExists = false;
  let backupExists = false;
  let output: FileHandle | undefined;
  let originalMode: number | undefined;
  let committed = false;
  let restoreAttempted = false;

  try {
    try {
      originalMode = (await filesystem.lstat(destination)).mode;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    output = await filesystem.open(stagingPath, 'wx');
    stagingExists = true;
    const result = await writer({ path: stagingPath, handle: output });
    await output.close();
    output = undefined;

    if (originalMode !== undefined) await filesystem.chmod(stagingPath, originalMode);

    if (originalMode !== undefined) {
      await filesystem.rename(destination, backupPath);
      backupExists = true;
    }

    try {
      await filesystem.rename(stagingPath, destination);
      stagingExists = false;
      committed = true;
    } catch (replacementError) {
      if (backupExists) {
        try {
          restoreAttempted = true;
          await filesystem.rename(backupPath, destination);
          backupExists = false;
        } catch (restoreError) {
          throw new AtomicOutputRecoveryError(
            [replacementError, restoreError],
            destination,
            backupPath,
            'may be present or its state is unknown because replacement rename and restoration both failed'
          );
        }
      }
      throw replacementError;
    }

    if (backupExists) {
      try {
        await filesystem.unlink(backupPath);
        backupExists = false;
      } catch (cleanupError) {
        const rollbackErrors: unknown[] = [cleanupError];
        let destinationStatus = 'is present with the replacement bytes';
        try {
          await filesystem.unlink(destination);
          committed = false;
          destinationStatus = 'is absent after the replacement was removed during failed rollback';
        } catch (removeError) {
          if (isMissing(removeError)) {
            committed = false;
            destinationStatus = 'is absent because replacement removal reported ENOENT during failed rollback';
          } else {
            rollbackErrors.push(removeError);
            destinationStatus = 'is present or its state is unknown because replacement removal failed';
          }
        }
        try {
          restoreAttempted = true;
          await filesystem.rename(backupPath, destination);
          backupExists = false;
          committed = false;
        } catch (restoreError) {
          rollbackErrors.push(restoreError);
          throw new AtomicOutputRecoveryError(rollbackErrors, destination, backupPath, destinationStatus);
        }
        throw new AggregateError(rollbackErrors, 'atomic output backup cleanup failed and commit was rolled back');
      }
    }

    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (output !== undefined) {
      try {
        await output.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (stagingExists) {
      try {
        await filesystem.unlink(stagingPath);
        stagingExists = false;
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError);
      }
    }
    if (backupExists && !committed && !restoreAttempted) {
      try {
        await filesystem.rename(backupPath, destination);
        backupExists = false;
      } catch (restoreError) {
        cleanupErrors.push(restoreError);
      }
    }
    if (cleanupErrors.length > 0) {
      const originalCauses: unknown[] = error instanceof AggregateError ? (error.errors as unknown[]) : [error];
      const causes = [...originalCauses, ...cleanupErrors];
      if (error instanceof AtomicOutputRecoveryError) {
        throw new AtomicOutputRecoveryError(causes, error.destination, error.backupPath, error.destinationStatus);
      }
      throw new AggregateError(causes, 'atomic output failed and cleanup was incomplete');
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
