import { lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { expect } from 'chai';
import {
  assertRunOwnedPath,
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../../src/filesystem/runOwnedTemp.js';

const MARKER = '.sf-mcnext-run-owner.json';

async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
    expect.fail('expected rejection');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

// All recursive cleanup below uses newly created, registered OS-temp children.
describe('run-owned recursive cleanup', () => {
  it('validates ownership repeatedly without mutating bytes, entries, or registrations', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-validation-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const sentinel = join(target, 'value.txt');
    const markerPath = join(run.root, MARKER);
    await writeFile(sentinel, 'preserve');
    const marker = await readFile(markerPath);
    const entries = await readdir(run.root);
    try {
      await assertRunOwnedPath(run, target);
      await assertRunOwnedPath(run, target);
      expect(await readFile(sentinel, 'utf8')).to.equal('preserve');
      expect(await readFile(markerPath)).to.deep.equal(marker);
      expect(await readdir(run.root)).to.deep.equal(entries);
      await rejects(() => removeRunOwnedRoot(run), 'paths remain registered');
    } finally {
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
    }
  });

  it('validation rejects forged, foreign, unregistered, root, and invalid targets without registering them', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-validation-test');
    const foreign = await createRunOwnedTemp('sf-mcnext-validation-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const unregistered = join(run.root, 'unregistered');
    await mkdir(unregistered);
    try {
      await rejects(() => assertRunOwnedPath({ root: run.root }, target), 'unknown run ownership');
      await rejects(() => assertRunOwnedPath(foreign, target), 'descendant');
      await rejects(() => assertRunOwnedPath(run, unregistered), 'not registered');
      for (const invalid of ['', run.root, parse(run.root).root, dirname(run.root), foreign.root, 'fixture']) {
        // eslint-disable-next-line no-await-in-loop -- independently check each ownership boundary
        await rejects(() => assertRunOwnedPath(run, invalid), invalid ? 'descendant' : 'invalid');
      }
      for (const invalid of ['*', '?', '[x]', '{x}', 'fixture/../fixture', 'fixture\\..\\fixture']) {
        // eslint-disable-next-line no-await-in-loop -- verify validation preserves raw escape checks
        await rejects(() => assertRunOwnedPath(run, `${run.root}/${invalid}`), 'invalid');
      }
      await rejects(() => removeRunOwnedPath(run, unregistered), 'not registered');
      expect(await readdir(unregistered)).to.deep.equal([]);
      expect((await lstat(target)).isDirectory()).to.equal(true);
    } finally {
      await rmdir(unregistered);
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
      await removeRunOwnedRoot(foreign);
    }
  });

  it('validation rejects changed markers without modifying their contents or removing the target', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-validation-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const markerPath = join(run.root, MARKER);
    const marker = await readFile(markerPath);
    try {
      await writeFile(markerPath, 'changed marker');
      await rejects(() => assertRunOwnedPath(run, target), 'marker mismatch');
      expect(await readFile(markerPath, 'utf8')).to.equal('changed marker');
      expect((await lstat(target)).isDirectory()).to.equal(true);
      await writeFile(markerPath, marker);
      await assertRunOwnedPath(run, target);
    } finally {
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
    }
  });

  it('uses frozen private ownership and removes only its created descendants', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    try {
      expect(Object.isFrozen(run)).to.equal(true);
      expect(Object.keys(run)).to.deep.equal(['root']);
      expect(() => Object.assign(run, { root: dirname(run.root) })).to.throw(TypeError);
      await rejects(() => removeRunOwnedPath({ root: run.root }, target), 'unknown run ownership');
      await rejects(
        () => createRunOwnedDirectory(Object.freeze({ root: run.root }), 'forged'),
        'unknown run ownership'
      );
      await rejects(() => removeRunOwnedRoot({ root: run.root }), 'unknown run ownership');
      await writeFile(join(target, 'value.txt'), 'fixture');
    } finally {
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
    }
  });

  it('rejects invalid paths, foreign ownership, and preexisting unregistered directories', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const foreign = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const unregistered = join(run.root, 'unregistered');
    await mkdir(unregistered);
    try {
      for (const invalid of ['', run.root, parse(run.root).root, dirname(run.root), foreign.root, 'fixture']) {
        // eslint-disable-next-line no-await-in-loop -- verify each invalid target independently
        await rejects(() => removeRunOwnedPath(run, invalid), invalid ? 'descendant' : 'invalid');
      }
      for (const invalid of ['*', '?', '[x]', '{x}', 'fixture/../fixture', 'fixture\\..\\fixture']) {
        // eslint-disable-next-line no-await-in-loop -- verify raw escape and wildcard rejection
        await rejects(() => removeRunOwnedPath(run, `${run.root}/${invalid}`), 'invalid');
      }
      for (const name of ['.', '..', 'a/b', 'a\\b', '*', MARKER]) {
        // eslint-disable-next-line no-await-in-loop -- validate each creation name
        await rejects(() => createRunOwnedDirectory(run, name), 'name is invalid');
      }
      await rejects(() => removeRunOwnedPath(foreign, target), 'descendant');
      await rejects(() => removeRunOwnedPath(run, unregistered), 'not registered');
      await rejects(() => createRunOwnedDirectory(run, 'unregistered'), 'EEXIST');
      await rejects(() => removeRunOwnedPath(run, unregistered), 'not registered');
      expect((await lstat(target)).isDirectory()).to.equal(true);
    } finally {
      await rmdir(unregistered);
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
      await removeRunOwnedRoot(foreign);
    }
  });

  it('refuses root teardown without changing marker or outstanding registrations', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const marker = await readFile(join(run.root, MARKER), 'utf8');
    await rejects(() => removeRunOwnedRoot(run), 'paths remain registered');
    expect(await readFile(join(run.root, MARKER), 'utf8')).to.equal(marker);
    await removeRunOwnedPath(run, target);
    const extra = join(run.root, 'extra');
    await writeFile(extra, 'sentinel');
    try {
      await rejects(() => removeRunOwnedRoot(run), 'not empty');
      expect(await readFile(extra, 'utf8')).to.equal('sentinel');
      expect(await readFile(join(run.root, MARKER), 'utf8')).to.equal(marker);
    } finally {
      await unlink(extra);
      await removeRunOwnedRoot(run);
    }
    await rejects(() => removeRunOwnedRoot(run), 'unknown run ownership');
  });

  it('rejects marker content and directory substitutions without deleting its target', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const markerPath = join(run.root, MARKER);
    const marker = await readFile(markerPath, 'utf8');
    try {
      await writeFile(markerPath, 'foreign marker');
      await rejects(() => removeRunOwnedPath(run, target), 'marker mismatch');
      await rejects(() => removeRunOwnedRoot(run), 'marker mismatch');
      await unlink(markerPath);
      await mkdir(markerPath);
      await rejects(() => removeRunOwnedPath(run, target), 'invalid run root or ownership marker');
      await rmdir(markerPath);
      await symlink(target, markerPath, 'junction');
      await rejects(
        () => removeRunOwnedPath(run, target),
        process.platform === 'win32' ? 'reparse point rejected' : 'link rejected'
      );
      await unlink(markerPath);
      await writeFile(markerPath, marker, { flag: 'wx' });
      expect((await lstat(target)).isDirectory()).to.equal(true);
    } finally {
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
    }
  });

  it('rejects root substitution and retains registration for the restored root', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const foreign = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const saved = join(foreign.root, 'saved');
    await rename(run.root, saved);
    try {
      await symlink(saved, run.root, 'junction');
      await rejects(() => assertRunOwnedPath(run, target), 'owned OS-temp directory');
      await rejects(() => removeRunOwnedPath(run, target), 'owned OS-temp directory');
      await rejects(() => removeRunOwnedRoot(run), 'owned OS-temp directory');
    } finally {
      await unlink(run.root);
      await rename(saved, run.root);
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
      await removeRunOwnedRoot(foreign);
    }
  });

  for (const type of ['junction', 'dir'] as const) {
    it(`rejects nested ${type} links and preserves foreign sentinels and registration`, async function () {
      const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
      const target = await createRunOwnedDirectory(run, 'fixture');
      const foreign = await createRunOwnedTemp('sf-mcnext-cleanup-test');
      const destination = await createRunOwnedDirectory(foreign, 'sentinel');
      const sentinel = join(destination, 'value.txt');
      const nested = join(target, 'nested');
      const link = join(nested, 'link');
      await mkdir(nested);
      await writeFile(sentinel, 'preserve');
      let linked = false;
      try {
        try {
          await symlink(destination, link, type);
          linked = true;
        } catch (error) {
          if (type !== 'dir' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          this.skip();
        }
        await rejects(
          () => assertRunOwnedPath(run, target),
          process.platform === 'win32' ? 'reparse point rejected' : 'link rejected'
        );
        await rejects(
          () => removeRunOwnedPath(run, target),
          process.platform === 'win32' ? 'reparse point rejected' : 'link rejected'
        );
        expect(await readFile(sentinel, 'utf8')).to.equal('preserve');
        expect(await readdir(nested)).to.deep.equal(['link']);
        await rejects(() => removeRunOwnedRoot(run), 'paths remain registered');
      } finally {
        if (linked) await unlink(link);
        await removeRunOwnedPath(run, target);
        await removeRunOwnedRoot(run);
        await removeRunOwnedPath(foreign, destination);
        await removeRunOwnedRoot(foreign);
      }
    });
  }

  it('rejects a marker link even when its contents match', async function () {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const markerPath = join(run.root, MARKER);
    const marker = await readFile(markerPath, 'utf8');
    const copy = join(target, 'copy');
    await writeFile(copy, marker);
    await unlink(markerPath);
    let linked = false;
    try {
      try {
        await symlink(copy, markerPath, 'file');
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        this.skip();
      }
      await rejects(
        () => removeRunOwnedPath(run, target),
        process.platform === 'win32' ? 'reparse point rejected' : 'link rejected'
      );
      expect(await readFile(copy, 'utf8')).to.equal(marker);
    } finally {
      if (linked) await unlink(markerPath);
      await writeFile(markerPath, marker, { flag: 'wx' });
      await removeRunOwnedPath(run, target);
      await removeRunOwnedRoot(run);
    }
  });
});
