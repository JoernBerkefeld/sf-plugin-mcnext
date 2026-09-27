import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const MARKER = '.sf-mcnext-run-owner.json';

export type RunOwnedTemp = { root: string; runId: string; registered: Set<string> };

export async function createRunOwnedTemp(prefix: string): Promise<RunOwnedTemp> {
  if (!/^[A-Za-z0-9-]+$/u.test(prefix)) throw new Error('temporary prefix is invalid');
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const runId = randomUUID();
  await writeFile(join(root, MARKER), `${JSON.stringify({ runId })}\n`, { encoding: 'utf8', flag: 'wx' });
  return { root: await realpath(root), runId, registered: new Set<string>() };
}

export async function createRunOwnedDirectory(run: RunOwnedTemp, name: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..') {
    throw new Error('run-owned directory name is invalid');
  }
  const root = await validateRoot(run);
  const target = join(root, name);
  await mkdir(target, { recursive: false });
  return registerRunOwnedPath(run, target);
}

export async function registerRunOwnedPath(run: RunOwnedTemp, target: string): Promise<string> {
  const canonical = await validateTarget(run, target);
  run.registered.add(canonical);
  return canonical;
}

export async function removeRunOwnedPath(run: RunOwnedTemp, target: string): Promise<void> {
  const canonical = await validateTarget(run, target);
  if (!run.registered.has(canonical)) throw new Error('cleanup target was not registered by this run');
  await rm(canonical, { force: true, recursive: true });
  run.registered.delete(canonical);
}

export async function removeRunOwnedRoot(run: RunOwnedTemp): Promise<void> {
  const canonical = await validateRoot(run);
  if (run.registered.size > 0) throw new Error('run-owned paths remain registered');
  await unlink(join(canonical, MARKER));
  await rmdir(canonical);
}

async function validateTarget(run: RunOwnedTemp, target: string): Promise<string> {
  if (target.length === 0) throw new Error('cleanup target must not be empty');
  const root = await validateRoot(run);
  const absolute = resolve(target);
  if (absolute === root) throw new Error('cleanup target must be a descendant, not the run root');
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || /[*?[]/u.test(rel)) {
    throw new Error('cleanup target must be a descendant of the run-owned temp root');
  }
  await rejectLinks(root, absolute);
  const canonical = await realpath(absolute);
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative.length === 0 || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)) {
    throw new Error('cleanup target resolves outside the run-owned temp root');
  }
  return canonical;
}

async function validateRoot(run: RunOwnedTemp): Promise<string> {
  const root = await realpath(run.root);
  const temp = await realpath(tmpdir());
  const rel = relative(temp, root);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('run root is outside OS temp');
  const marker = JSON.parse(await readFile(join(root, MARKER), 'utf8')) as { runId?: unknown };
  if (marker.runId !== run.runId) throw new Error('run-owned temp marker mismatch');
  return root;
}

async function rejectLinks(root: string, target: string): Promise<void> {
  let current = target;
  const entries = [];
  while (current !== root) {
    entries.push(current);
    current = dirname(current);
    if (current.length < root.length) throw new Error('cleanup target escapes run root');
  }
  for (const entry of entries.reverse()) {
    // eslint-disable-next-line no-await-in-loop -- every path component must be checked in traversal order
    const metadata = await lstat(entry);
    if (metadata.isSymbolicLink()) throw new Error(`cleanup path contains a link: ${basename(entry)}`);
  }
}
