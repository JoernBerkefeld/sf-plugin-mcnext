import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

// Test and script support only: this module runs powershell.exe on Windows and is not part of the
// published package (package.json "files" lists lib/, which is compiled from src/ alone).

/** @typedef {Readonly<{ root: string }>} RunOwnedTemp */
/** @typedef {{ marker: string; registered: Set<string> }} Owner */

const execute = promisify(execFile);
const MARKER = '.sf-mcnext-run-owner.json';
/** @type {WeakMap<RunOwnedTemp, Owner>} */
const owners = new WeakMap();

/**
 * @param {string} prefix
 * @returns {Promise<RunOwnedTemp>}
 */
export async function createRunOwnedTemp(prefix) {
  if (!/^[A-Za-z0-9-]+$/u.test(prefix)) throw new Error('temporary prefix is invalid');
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), `${prefix}-`)));
  await rejectAncestors(root);
  const marker = `${JSON.stringify({ runId: randomUUID() })}\n`;
  await writeFile(join(root, MARKER), marker, { encoding: 'utf8', flag: 'wx' });
  const run = Object.freeze({ root });
  owners.set(run, { marker, registered: new Set() });
  return run;
}

// Only directories created by this run can become recursive cleanup targets.
/**
 * @param {RunOwnedTemp} run
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function createRunOwnedDirectory(run, name) {
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..' || name === MARKER) {
    throw new Error('run-owned directory name is invalid');
  }
  const owner = await validateRoot(run);
  const target = join(run.root, name);
  await mkdir(target, { recursive: false });
  owner.registered.add(target);
  return target;
}

/**
 * Validate an existing registered run-owned path without changing files or ownership.
 *
 * @param {RunOwnedTemp} run
 * @param {string} target
 * @returns {Promise<void>}
 */
export async function assertRunOwnedPath(run, target) {
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

/**
 * @param {RunOwnedTemp} run
 * @param {string} target
 * @returns {Promise<void>}
 */
export async function removeRunOwnedPath(run, target) {
  await assertRunOwnedPath(run, target);
  const absolute = resolve(target);
  await rm(absolute, { force: false, recursive: true });
  owners.get(run)?.registered.delete(absolute);
}

/**
 * @param {RunOwnedTemp} run
 * @returns {Promise<void>}
 */
export async function removeRunOwnedRoot(run) {
  const owner = await validateRoot(run);
  if (owner.registered.size > 0) throw new Error('run-owned paths remain registered');
  const entries = await readdir(run.root);
  if (entries.length !== 1 || entries[0] !== MARKER) throw new Error('run-owned root is not empty');
  await unlink(join(run.root, MARKER));
  await rmdir(run.root);
  owners.delete(run);
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isDescendant(root, target) {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * @param {RunOwnedTemp} run
 * @returns {Promise<Owner>}
 */
async function validateRoot(run) {
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

/**
 * @param {string} target
 * @param {boolean} [inspectSubtree]
 * @returns {Promise<void>}
 */
async function rejectAncestors(target, inspectSubtree = false) {
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
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('cleanup ancestor link rejected');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (inspectSubtree) await inspectTree(target);
}

/**
 * @param {string} target
 * @returns {Promise<void>}
 */
async function inspectTree(target) {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) throw new Error('cleanup subtree link rejected');
  if (!metadata.isDirectory()) return;
  const entries = await readdir(target);
  await Promise.all(entries.map((entry) => inspectTree(join(target, entry))));
}
