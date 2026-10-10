import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MARKER = '.sf-mcnext-run-owner.json';
export type RunOwnedTemp = Readonly<{ root: string }>;
type Owner = { marker: string; registered: Set<string> };
const owners = new WeakMap<RunOwnedTemp, Owner>();

export async function createRunOwnedTemp(prefix: string): Promise<RunOwnedTemp> {
  if (!/^[A-Za-z0-9-]+$/u.test(prefix)) throw new Error('temporary prefix is invalid');
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), `${prefix}-`)));
  await rejectAncestors(root);
  const marker = `${JSON.stringify({ runId: randomUUID() })}\n`;
  await writeFile(join(root, MARKER), marker, { encoding: 'utf8', flag: 'wx' });
  const run = Object.freeze({ root });
  owners.set(run, { marker, registered: new Set<string>() });
  return run;
}

// Only directories created by this run can become recursive cleanup targets.
export async function createRunOwnedDirectory(run: RunOwnedTemp, name: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..' || name === MARKER) {
    throw new Error('run-owned directory name is invalid');
  }
  const owner = await validateRoot(run);
  const target = join(run.root, name);
  await mkdir(target, { recursive: false });
  owner.registered.add(target);
  return target;
}

/** Validate an existing registered run-owned path without changing files or ownership. */
export async function assertRunOwnedPath(run: RunOwnedTemp, target: string): Promise<void> {
  const owner = await validateRoot(run);
  if (!target || /[*?[\]{}]/u.test(target) || target.split(/[\\/]/u).includes('..')) {
    throw new Error('cleanup target is invalid');
  }
  const absolute = resolve(target);
  if (!isAbsolute(target) || !isDescendant(run.root, absolute)) {
    throw new Error('cleanup target must be a strict run-root descendant');
  }
  if (!owner.registered.has(absolute)) throw new Error('cleanup target was not registered by this run');
  await rejectAncestors(absolute, true);
  if ((await realpath(absolute)) !== absolute) throw new Error('cleanup target changed location');
}

export async function removeRunOwnedPath(run: RunOwnedTemp, target: string): Promise<void> {
  await assertRunOwnedPath(run, target);
  const absolute = resolve(target);
  await rm(absolute, { force: false, recursive: true });
  owners.get(run)!.registered.delete(absolute);
}

export async function removeRunOwnedRoot(run: RunOwnedTemp): Promise<void> {
  const owner = await validateRoot(run);
  if (owner.registered.size > 0) throw new Error('run-owned paths remain registered');
  const entries = await readdir(run.root);
  if (entries.length !== 1 || entries[0] !== MARKER) throw new Error('run-owned root is not empty');
  await unlink(join(run.root, MARKER));
  await rmdir(run.root);
  owners.delete(run);
}

function isDescendant(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function validateRoot(run: RunOwnedTemp): Promise<Owner> {
  const owner = owners.get(run);
  if (!owner) throw new Error('unknown run ownership');
  if (!isDescendant(await realpath(tmpdir()), run.root) || (await realpath(run.root)) !== run.root) {
    throw new Error('run root is not an owned OS-temp directory');
  }
  const markerPath = join(run.root, MARKER);
  await rejectAncestors(markerPath);
  const metadata = await lstat(run.root);
  const markerMetadata = await lstat(markerPath);
  if (!metadata.isDirectory() || !markerMetadata.isFile()) throw new Error('invalid run root or ownership marker');
  if ((await readFile(markerPath, 'utf8')) !== owner.marker) throw new Error('run-owned temp marker mismatch');
  return owner;
}

async function rejectAncestors(target: string, inspectSubtree = false): Promise<void> {
  // Node does not expose every Windows reparse type. PowerShell failures must propagate.
  if (process.platform === 'win32') {
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
        $ErrorActionPreference = 'Stop'
        $target = $env:SF_MCNEXT_CLEANUP_TARGET
        $current = $target
        while ($true) {
          $item = Get-Item -LiteralPath $current -Force
          if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup reparse point rejected' }
          $parent = [IO.Path]::GetDirectoryName($current)
          if (-not $parent -or $parent -eq $current) { break }
          $current = $parent
        }
        if ($env:SF_MCNEXT_CLEANUP_SUBTREE -eq 'true') {
          $pending = New-Object 'Collections.Generic.Stack[string]'
          $pending.Push($target)
          while ($pending.Count -gt 0) {
            $item = Get-Item -LiteralPath $pending.Pop() -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup reparse point rejected' }
            if ($item.PSIsContainer) {
              foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child.FullName) }
            }
          }
        }
        `,
      ],
      {
        env: {
          ...process.env,
          SF_MCNEXT_CLEANUP_TARGET: target,
          SF_MCNEXT_CLEANUP_SUBTREE: String(inspectSubtree),
        },
        windowsHide: true,
      }
    );
  }
  let current = target;
  while (current !== '') {
    // eslint-disable-next-line no-await-in-loop -- inspect every ancestor before cleanup
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('cleanup ancestor link rejected');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (inspectSubtree) await inspectTree(target);
}

async function inspectTree(target: string): Promise<void> {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) throw new Error('cleanup subtree link rejected');
  if (!metadata.isDirectory()) return;
  const entries = await readdir(target);
  await Promise.all(entries.map((entry) => inspectTree(join(target, entry))));
}
