import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../lib/filesystem/runOwnedTemp.js';

const packageRoot = resolve(import.meta.dirname, '..');

test('CMS dependency and registry lock align with the info-v2 candidate', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies['sf-plugin-cms'], '^0.9.0');
  assert.equal(lock.packages[''].dependencies['sf-plugin-cms'], '^0.9.0');
  assert.equal(lock.packages['node_modules/sf-plugin-cms'].version, '0.9.0');
  assert.equal(
    lock.packages['node_modules/sf-plugin-cms'].resolved,
    'https://registry.npmjs.org/sf-plugin-cms/-/sf-plugin-cms-0.9.0.tgz'
  );
  assert.match(lock.packages['node_modules/sf-plugin-cms'].integrity, /^sha512-/u);
  assert.notEqual(lock.packages['node_modules/sf-plugin-cms'].link, true);
});

for (const failPack of [false, true]) {
  test(`lifecycle cleans owned pack child and root after pack ${failPack ? 'failure' : 'success'}`, async () => {
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
    'package/lib/commands/synthetic.js', 'package/lib/index.js',
    'package/oclif.manifest.json', 'package/package.json',
  ].join('\\n');
  if (args[0] === '-xOf') return readFileSync(join(root, args[2].replace(/^package\\//u, '')), 'utf8');
  if (args[0] === '-xf') {
    const destination = join(args[3], args[4]);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(root, 'lib/registry/registry.js'), 'utf8'));
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
