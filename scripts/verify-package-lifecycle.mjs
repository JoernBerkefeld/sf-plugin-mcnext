import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { parseNpmPackOutput } from './parse-npm-pack-output.mjs';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from './run-owned-temp.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'npm_execpath is required to run the package lifecycle');

execFileSync(
  process.execPath,
  [
    join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    'tsconfig.json',
    '--pretty',
    '--incremental',
    'false',
  ],
  {
    cwd: packageRoot,
    stdio: 'inherit',
  }
);
const cleanupRun = await createRunOwnedTemp('sf-plugin-mcnext-package');
const workDir = await createRunOwnedDirectory(cleanupRun, 'pack');

try {
  const packedFiles = execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', workDir], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  const packResults = parseNpmPackOutput(packedFiles);
  assert.equal(packResults.length, 1, 'npm pack must report exactly one package result');
  const [packResult] = packResults;
  assert.ok(packResult && typeof packResult === 'object', 'npm pack result must be an object');
  assert.equal(typeof packResult.filename, 'string', 'npm pack did not report a package filename');
  assert.equal(packResult.filename, basename(packResult.filename), 'npm pack reported an unexpected package path');
  assert.match(packResult.filename, /\.tgz$/u, 'npm pack did not report a tarball');

  const tarball = join(workDir, packResult.filename);
  const entries = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean);
  const entrySet = new Set(entries);

  assert.ok(entrySet.has('package/lib/index.js'), 'package entry point is missing');
  assert.ok(entrySet.has('package/oclif.manifest.json'), 'oclif manifest is missing');

  const manifestText = execFileSync('tar', ['-xOf', tarball, 'package/oclif.manifest.json'], { encoding: 'utf8' });
  assert.ok(manifestText.trim().length > 2, 'oclif manifest is empty');
  const manifest = JSON.parse(manifestText);
  const commandIds = Object.keys(manifest.commands ?? {}).sort();
  const expectedCommandIds = ['mcnext:delete', 'mcnext:deploy', 'mcnext:list:business-unit', 'mcnext:retrieve'];
  assert.deepEqual(commandIds, expectedCommandIds, 'manifest public command IDs do not match the package contract');
  for (const id of expectedCommandIds) {
    const compiled = `package/lib/commands/${id.replaceAll(':', '/')}.js`;
    assert.ok(entrySet.has(compiled), `compiled command is missing: ${compiled}`);
  }
  const compiledCommands = entries.filter((entry) => /^package\/lib\/commands\/.*\.js$/u.test(entry));
  assert.equal(compiledCommands.length, expectedCommandIds.length, 'package contains an unlisted compiled command');

  // The packed code must load on its own: routing is the contract every command builds on.
  for (const module of ['package/lib/envelope.js', 'package/lib/selectors.js']) {
    assert.ok(entrySet.has(module), `${module} is missing`);
    execFileSync('tar', ['-xf', tarball, '-C', workDir, module]);
  }
  const selectorsUrl = pathToFileURL(join(workDir, 'package', 'lib', 'selectors.js'));
  const { DATA360_FAMILIES, areaOfType } = await import(selectorsUrl.href);
  assert.equal(DATA360_FAMILIES.length, 10, 'packed selectors do not list the ten Data 360 families');
  assert.deepEqual(
    ['campaign', 'flow', 'segment', 'email'].map((type) => areaOfType(type)),
    ['mcnext', 'mcnext', 'data360', 'cms'],
    'packed selector routing does not match the package contract'
  );

  const forbidden = [
    /^package\/(?:\.cursor|\.sf|\.wireit|coverage|tmp)(?:\/|$)/u,
    /^package\/(?:_mcnext-probe\.mjs|_probe-output)(?:\/|$)/u,
    /(?:^|\/)(?:\.env(?:\..*)?|.*credential.*|.*evidence.*)$/iu,
    /^package\/(?:mcp\.json|\.mcp\.json)$/u,
    // Test and script support, such as the run-owned temp helper that starts powershell.exe, is never shipped.
    /^package\/(?:scripts|test)(?:\/|$)/u,
    /run-?owned-?temp/iu,
  ];
  const forbiddenEntries = entries.filter((entry) => forbidden.some((pattern) => pattern.test(entry)));
  assert.deepEqual(forbiddenEntries, [], `forbidden package content: ${forbiddenEntries.join(', ')}`);

  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports, './lib/index.js', 'package export must point to the compiled entry point');
  const cmsDependencyRange = packageJson.dependencies?.['sf-plugin-cms'];
  assert.equal(cmsDependencyRange, '^0.26.0', 'CMS provider must target the release with the in-process API');
  assert.deepEqual(
    packageJson.oclif?.plugins,
    ['sf-plugin-cms'],
    'CMS provider must remain registered as an oclif plugin'
  );

  const packedPackageJsonText = execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  const packedPackageJson = JSON.parse(packedPackageJsonText);
  assert.equal(
    packedPackageJson.dependencies?.['sf-plugin-cms'],
    cmsDependencyRange,
    'packed CMS provider dependency does not match package metadata'
  );
  assert.deepEqual(
    packedPackageJson.oclif?.plugins,
    ['sf-plugin-cms'],
    'packed CMS provider oclif registration does not match the release contract'
  );
  process.stdout.write(`Verified ${basename(tarball)} (${entries.length} files, ${commandIds.length} commands).\n`);
} finally {
  await removeRunOwnedPath(cleanupRun, workDir);
  await removeRunOwnedRoot(cleanupRun);
}
