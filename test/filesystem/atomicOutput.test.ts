import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  AtomicOutputRecoveryError,
  writeAtomicOutput,
  type AtomicOutputFilesystem,
  type AtomicOutputFile,
} from '../../src/filesystem/atomicOutput.js';

const realFilesystem: AtomicOutputFilesystem = { mkdir, lstat, open, rename, unlink, chmod };

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sf-mcnext-atomic-output-'));
  try {
    await run(root);
  } finally {
    await Promise.all((await readdir(root)).map(async (name) => unlink(join(root, name)).catch(() => undefined)));
    await rmdir(root);
  }
}

async function write(output: AtomicOutputFile, value: string): Promise<void> {
  await output.handle.writeFile(value, 'utf8');
  await output.handle.close();
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
    expect.fail('expected rejection');
  } catch (error) {
    return error as Error;
  }
}

describe('atomic output', () => {
  it('creates a missing parent and destination on success', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'parent', 'output.csv');
      await writeAtomicOutput(destination, async (output) => write(output, 'new'));
      expect(await readFile(destination, 'utf8')).to.equal('new');
      await unlink(destination);
      await rmdir(join(root, 'parent'));
    });
  });

  it('replaces an existing destination and preserves its permissions', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      await writeFile(destination, 'old');
      await chmod(destination, 0o640);
      const oldMode = (await lstat(destination)).mode & 0o777;
      await writeAtomicOutput(destination, async (output) => write(output, 'new'));
      expect(await readFile(destination, 'utf8')).to.equal('new');
      expect((await lstat(destination)).mode & 0o777).to.equal(oldMode);
    });
  });

  it('preserves the destination when writing or closing fails and removes staging', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      await writeFile(destination, 'original');
      await captureError(() =>
        writeAtomicOutput(destination, async (output) => {
          await write(output, 'partial');
          throw new Error('write failed');
        })
      );
      expect(await readFile(destination, 'utf8')).to.equal('original');
      expect((await readdir(root)).sort()).to.deep.equal(['output.csv']);

      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        open: async (...args) => {
          const handle = await open(...args);
          const close = handle.close.bind(handle);
          let firstClose = true;
          return Object.assign(handle, {
            close: async () => {
              if (!firstClose) return;
              firstClose = false;
              await close();
              throw new Error('close failed');
            },
          });
        },
      };
      const error = await captureError(() =>
        writeAtomicOutput(destination, async (output) => write(output, 'partial'), { filesystem })
      );
      expect(error.message).to.include('close failed');
      expect(await readFile(destination, 'utf8')).to.equal('original');
    });
  });

  it('restores the exact original when final replacement fails with EPERM', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      const original = Buffer.from([0, 255, 10, 13, 7]);
      await writeFile(destination, original);
      let renameCalls = 0;
      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        rename: async (from, to) => {
          renameCalls += 1;
          if (renameCalls === 2) {
            const error = new Error('simulated Windows replacement lock') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          await rename(from, to);
        },
      };
      const error = await captureError(() =>
        writeAtomicOutput(destination, async (output) => write(output, 'replacement'), { filesystem })
      );
      expect((error as NodeJS.ErrnoException).code).to.equal('EPERM');
      expect(await readFile(destination)).to.deep.equal(original);
      expect((await readdir(root)).sort()).to.deep.equal(['output.csv']);
    });
  });

  it('retains the original backup and reports its exact path when replacement restoration is impossible', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      await writeFile(destination, 'original');
      let renameCalls = 0;
      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        rename: async (from, to) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error('replacement failed');
          if (String(from).endsWith('.backup') && to === destination) throw new Error('restore failed');
          await rename(from, to);
        },
      };
      const error = (await captureError(() =>
        writeAtomicOutput(destination, async (output) => write(output, 'replacement'), { filesystem })
      )) as AggregateError;

      expect(error).to.be.instanceOf(AtomicOutputRecoveryError);
      expect(error.message).to.include(
        'Destination may be present or its state is unknown because replacement rename and restoration both failed'
      );
      const retainedNames = await readdir(root);
      expect(retainedNames).to.have.length(1);
      const retainedPath = join(root, retainedNames[0]);
      expect(error.message).to.include(`Original retained at backup path: ${retainedPath}`);
      expect(await readFile(retainedPath, 'utf8')).to.equal('original');
    });
  });

  it('reports cleanup failure without changing the original destination', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      await writeFile(destination, 'original');
      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        unlink: async (path) => {
          if (String(path).endsWith('.stage')) throw new Error('cleanup denied');
          await unlink(path);
        },
      };
      const error = await captureError(() =>
        writeAtomicOutput(
          destination,
          async (output) => {
            await output.handle.writeFile('partial', 'utf8');
            throw new Error('writer failed');
          },
          { filesystem }
        )
      );
      expect(error).to.be.instanceOf(AggregateError);
      expect(error.message).to.equal('atomic output failed and cleanup was incomplete');
      expect(await readFile(destination, 'utf8')).to.equal('original');
    });
  });

  for (const code of ['EPERM', 'EACCES'] as const) {
    it(`rolls back a committed destination when backup cleanup fails with ${code}`, async () => {
      await withFixture(async (root) => {
        const destination = join(root, 'output.csv');
        await writeFile(destination, 'original');
        const filesystem: AtomicOutputFilesystem = {
          ...realFilesystem,
          unlink: async (path) => {
            if (String(path).endsWith('.backup')) {
              const error = new Error('cleanup denied') as NodeJS.ErrnoException;
              error.code = code;
              throw error;
            }
            await unlink(path);
          },
        };
        const error = await captureError(() =>
          writeAtomicOutput(destination, async (output) => write(output, 'replacement'), { filesystem })
        );
        expect(error).to.be.instanceOf(AggregateError);
        expect(error.message).to.equal('atomic output backup cleanup failed and commit was rolled back');
        expect(await readFile(destination, 'utf8')).to.equal('original');
        expect(await readdir(root)).to.deep.equal(['output.csv']);
      });
    });
  }

  it('aggregates cleanup and restore failures after removing the new destination', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      await writeFile(destination, 'original');
      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        rename: async (from, to) => {
          if (String(from).endsWith('.backup') && to === destination) throw new Error('restore failed');
          await rename(from, to);
        },
        unlink: async (path) => {
          if (String(path).endsWith('.backup')) {
            const error = new Error('cleanup denied') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          await unlink(path);
        },
      };
      const error = (await captureError(() =>
        writeAtomicOutput(destination, async (output) => write(output, 'replacement'), { filesystem })
      )) as AtomicOutputRecoveryError;
      expect(error).to.be.instanceOf(AtomicOutputRecoveryError);
      expect(error.name).to.equal('AtomicOutputRecoveryError');
      expect(error.errors.map((cause) => (cause as Error).message)).to.deep.equal(['cleanup denied', 'restore failed']);
      expect(error.destination).to.equal(destination);
      expect(error.destinationStatus).to.equal('is absent after the replacement was removed during failed rollback');
      const retainedNames = await readdir(root);
      expect(retainedNames).to.have.length(1);
      expect(retainedNames[0]).to.match(/\.backup$/u);
      const retainedPath = join(root, retainedNames[0]);
      expect(error.backupPath).to.equal(retainedPath);
      expect(error.message).to.include(`Original retained at backup path: ${retainedPath}`);
      expect(await readFile(retainedPath, 'utf8')).to.equal('original');
    });
  });

  it('reports destination present or unknown when replacement removal and restoration fail', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      const original = Buffer.from([0, 255, 10, 13, 7]);
      await writeFile(destination, original);
      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        rename: async (from, to) => {
          if (String(from).endsWith('.backup') && to === destination) throw new Error('restore failed');
          await rename(from, to);
        },
        unlink: async (path) => {
          if (String(path).endsWith('.backup')) throw new Error('backup cleanup denied');
          if (path === destination) throw new Error('replacement removal denied');
          await unlink(path);
        },
      };
      const error = (await captureError(() =>
        writeAtomicOutput(destination, async (output) => write(output, 'replacement'), { filesystem })
      )) as AtomicOutputRecoveryError;

      expect(error).to.be.instanceOf(AtomicOutputRecoveryError);
      expect(error.errors.map((cause) => (cause as Error).message)).to.deep.equal([
        'backup cleanup denied',
        'replacement removal denied',
        'restore failed',
      ]);
      expect(error.destination).to.equal(destination);
      expect(error.destinationStatus).to.equal('is present or its state is unknown because replacement removal failed');
      expect(error.message).to.include('Destination is present or its state is unknown');
      expect(await readFile(destination, 'utf8')).to.equal('replacement');
      expect(await readFile(error.backupPath)).to.deep.equal(original);
      expect((await readdir(root)).sort()).to.deep.equal(
        [error.backupPath.split(/[\\/]/u).at(-1), 'output.csv'].sort()
      );
    });
  });

  it('preserves the recovery error when later staging cleanup also fails', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      const original = Buffer.from([0, 255, 10, 13, 7]);
      await writeFile(destination, original);
      let renameCalls = 0;
      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        rename: async (from, to) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error('replacement failed');
          if (String(from).endsWith('.backup') && to === destination) throw new Error('restore failed');
          await rename(from, to);
        },
        unlink: async (path) => {
          if (String(path).endsWith('.stage')) throw new Error('staging cleanup denied');
          await unlink(path);
        },
      };
      const error = (await captureError(() =>
        writeAtomicOutput(destination, async (output) => write(output, 'replacement'), { filesystem })
      )) as AtomicOutputRecoveryError;

      expect(error).to.be.instanceOf(AtomicOutputRecoveryError);
      expect(error.name).to.equal('AtomicOutputRecoveryError');
      expect(error.errors.map((cause) => (cause as Error).message)).to.deep.equal([
        'replacement failed',
        'restore failed',
        'staging cleanup denied',
      ]);
      expect(error.destination).to.equal(destination);
      expect(error.destinationStatus).to.equal(
        'may be present or its state is unknown because replacement rename and restoration both failed'
      );
      expect(error.message).to.include(`Original retained at backup path: ${error.backupPath}`);
      const retainedNames = await readdir(root);
      expect(retainedNames).to.have.length(2);
      expect(retainedNames).to.include(error.backupPath.split(/[\\/]/u).at(-1));
      expect(retainedNames.some((name) => name.endsWith('.stage'))).to.equal(true);
      expect(await readFile(error.backupPath)).to.deep.equal(original);
    });
  });

  it('uses unique staging names for concurrent writes', async () => {
    await withFixture(async (root) => {
      const paths: string[] = [];
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived = 0;
      const destination = join(root, 'output.csv');
      const run = () =>
        captureError(() =>
          writeAtomicOutput(destination, async (output) => {
            paths.push(output.path);
            arrived += 1;
            if (arrived === 2) release();
            await barrier;
            throw new Error('stop before commit');
          })
        );
      await Promise.all([run(), run()]);
      expect(new Set(paths).size).to.equal(2);
      expect(await readdir(root)).to.deep.equal([]);
    });
  });

  it('does not retry or remove unrelated files when staging open reports EEXIST', async () => {
    await withFixture(async (root) => {
      const destination = join(root, 'output.csv');
      const unrelated = join(root, 'keep.txt');
      await writeFile(unrelated, 'keep');
      const filesystem: AtomicOutputFilesystem = {
        ...realFilesystem,
        open: async () => {
          const error = new Error('collision') as NodeJS.ErrnoException;
          error.code = 'EEXIST';
          throw error;
        },
      };
      const error = await captureError(() =>
        writeAtomicOutput(destination, async (output) => write(output, 'new'), { filesystem })
      );
      expect((error as NodeJS.ErrnoException).code).to.equal('EEXIST');
      expect(await readFile(unrelated, 'utf8')).to.equal('keep');
    });
  });
});
