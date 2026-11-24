import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from './run-owned-temp.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

test('CMS dependency and registry lock align with the release that has the in-process API', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies['sf-plugin-cms'], '^0.26.0');
  assert.equal(lock.packages[''].dependencies['sf-plugin-cms'], '^0.26.0');
  assert.equal(lock.packages['node_modules/sf-plugin-cms'].version, '0.26.0');
  assert.equal(
    lock.packages['node_modules/sf-plugin-cms'].resolved,
    'https://registry.npmjs.org/sf-plugin-cms/-/sf-plugin-cms-0.26.0.tgz'
  );
  assert.match(lock.packages['node_modules/sf-plugin-cms'].integrity, /^sha512-/u);
  assert.notEqual(lock.packages['node_modules/sf-plugin-cms'].link, true);
});

for (const mode of ['success', 'failure', 'shipped temp helper']) {
  const failPack = mode === 'failure';
  test(`lifecycle cleans owned pack child and root after pack ${mode}`, async () => {
    const run = await createRunOwnedTemp('sf-mcnext-lifecycle-test');
    const fixture = await createRunOwnedDirectory(run, 'fixture');
    try {
      const record = join(fixture, 'record.json');
      const npmCli = join(fixture, 'npm.cjs');
      const preload = join(fixture, 'preload.mjs');
      await writeFile(
        npmCli,
        `
const fs = require('node:fs');
const path = require('node:path');
const workDir = process.argv[process.argv.indexOf('--pack-destination') + 1];
fs.writeFileSync(process.env.LIFECYCLE_RECORD, JSON.stringify({ workDir, root: path.dirname(workDir) }));
fs.writeFileSync(path.join(workDir, 'synthetic.tgz'), 'synthetic pack output');
if (process.env.FAIL_PACK === 'true') {
  process.stderr.write('synthetic npm pack failure 37\\n');
  process.exit(37);
}
process.stdout.write(JSON.stringify([{ filename: 'synthetic.tgz' }]));
`
      );
      // Stub compilation and tar only; pack still executes a real synthetic subprocess.
      await writeFile(
        preload,
        `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const original = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (file === process.execPath && args[1] === '-p' && args[2] === 'tsconfig.json') return '';
  if (file !== 'tar') return original(file, args, options);
  const root = process.env.LIFECYCLE_PACKAGE_ROOT;
  if (args[0] === '-tf') return [
    'package/lib/index.js', 'package/lib/envelope.js', 'package/lib/selectors.js',
    'package/oclif.manifest.json', 'package/package.json',
    ...(process.env.LIFECYCLE_EXTRA_ENTRY ? [process.env.LIFECYCLE_EXTRA_ENTRY] : []),
    ...Object.keys(JSON.parse(readFileSync(join(root, 'oclif.manifest.json'), 'utf8')).commands)
      .map((id) => 'package/lib/commands/' + id.replaceAll(':', '/') + '.js'),
  ].join('\\n');
  if (args[0] === '-xOf') return readFileSync(join(root, args[2].replace(/^package\\//u, '')), 'utf8');
  if (args[0] === '-xf') {
    const destination = join(args[3], args[4]);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(root, args[4].replace(/^package\\//u, '')), 'utf8'));
    return '';
  }
  throw new Error('Unexpected synthetic tar invocation');
};
syncBuiltinESMExports();
`
      );
      const result = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(preload).href, 'scripts/verify-package-lifecycle.mjs'],
        {
          cwd: packageRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            npm_execpath: npmCli,
            FAIL_PACK: String(failPack),
            LIFECYCLE_RECORD: record,
            LIFECYCLE_PACKAGE_ROOT: packageRoot,
            LIFECYCLE_EXTRA_ENTRY: mode === 'shipped temp helper' ? 'package/lib/filesystem/runOwnedTemp.js' : '',
          },
        }
      );
      assert.ifError(result.error);
      const { workDir, root } = JSON.parse(await readFile(record, 'utf8'));
      assert.equal(dirname(workDir), root);
      assert.equal(existsSync(workDir), false, 'owned pack child must be removed');
      assert.equal(existsSync(root), false, 'owned run root must be removed');
      if (failPack) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /synthetic npm pack failure 37/u);
        assert.match(result.stderr, /status: 37/u, 'original npm failure status must survive cleanup');
        assert.doesNotMatch(result.stdout, /Verified/u);
      } else if (mode === 'shipped temp helper') {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /forbidden package content: package\/lib\/filesystem\/runOwnedTemp\.js/u);
        assert.doesNotMatch(result.stdout, /Verified/u);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Verified synthetic\.tgz/u);
      }
    } finally {
      await removeRunOwnedPath(run, fixture);
      await removeRunOwnedRoot(run);
    }
  });
}

test('shipped source starts no child process and the temp helper is outside the package', async () => {
  const sources = (await readdir(join(packageRoot, 'src'), { recursive: true, withFileTypes: true })).filter((entry) =>
    entry.isFile()
  );
  assert.ok(sources.length > 0);
  for (const entry of sources) {
    const path = join(entry.parentPath, entry.name);
    assert.doesNotMatch(await readFile(path, 'utf8'), /child_process/u, `${path} must not start a child process`);
    assert.doesNotMatch(entry.name, /run-?owned-?temp/iu, `${path} belongs to scripts/, not to the shipped source`);
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.files, ['/lib', '/messages', '/oclif.manifest.json', '/oclif.lock']);
  assert.equal(existsSync(join(packageRoot, 'scripts', 'run-owned-temp.mjs')), true);
});
