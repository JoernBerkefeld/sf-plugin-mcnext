import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { expect } from 'chai';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  registerRunOwnedPath,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../../src/filesystem/runOwnedTemp.js';

async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
    expect.fail('expected rejection');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

describe('run-owned recursive cleanup', () => {
  it('removes only a registered descendant inside its own OS temp run root', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    await writeFile(join(target, 'value.txt'), 'fixture');
    await removeRunOwnedPath(run, target);
    await removeRunOwnedRoot(run);
  });

  it('rejects empty, root, ancestor, outside, wildcard, and unregistered targets', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = join(run.root, 'fixture');
    await mkdir(target);
    await rejects(() => registerRunOwnedPath(run, ''), 'must not be empty');
    await rejects(() => registerRunOwnedPath(run, run.root), 'not the run root');
    await rejects(() => registerRunOwnedPath(run, parse(run.root).root), 'descendant');
    await rejects(() => registerRunOwnedPath(run, join(run.root, '..')), 'descendant');
    await rejects(() => registerRunOwnedPath(run, join(run.root, '*')), 'descendant');
    await rejects(() => removeRunOwnedPath(run, target), 'not registered');
    await registerRunOwnedPath(run, target);
    await removeRunOwnedPath(run, target);
    await removeRunOwnedRoot(run);
  });

  it('removes the run root only after descendants are gone and without recursive root deletion', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const target = join(run.root, 'fixture');
    await mkdir(target);
    await registerRunOwnedPath(run, target);
    await rejects(() => removeRunOwnedRoot(run), 'paths remain registered');
    await removeRunOwnedPath(run, target);
    await removeRunOwnedRoot(run);
  });

  it('rejects link traversal within the owned run root', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-cleanup-test');
    const real = join(run.root, 'real');
    const link = join(run.root, 'link');
    await mkdir(real);
    try {
      await symlink(real, link, 'junction');
      await rejects(() => registerRunOwnedPath(run, link), 'contains a link');
    } finally {
      await unlink(link).catch(() => undefined);
      await registerRunOwnedPath(run, real);
      await removeRunOwnedPath(run, real);
      await removeRunOwnedRoot(run);
    }
  });
});
