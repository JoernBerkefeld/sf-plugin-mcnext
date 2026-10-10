import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadNycConfig } from '@istanbuljs/load-nyc-config';
import { loadOptions } from 'mocha/lib/cli/options.js';
import NYC from 'nyc';
import Yargs from 'yargs/yargs';
import { setupOptions } from 'nyc/lib/commands/helpers.js';
import { shouldInstrument } from './coverage-loader.mjs';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../lib/filesystem/runOwnedTemp.js';

const packageRoot = resolve(import.meta.dirname, '..');
const children = [];
let run;
let exitCode = 0;
try {
  run = await createRunOwnedTemp('sf-mcnext-unit-tests');
  const raw = await createRunOwnedDirectory(run, 'raw');
  children.push(raw);
  const report = await createRunOwnedDirectory(run, 'report');
  children.push(report);
  const configDirectory = await createRunOwnedDirectory(run, 'config');
  children.push(configDirectory);
  const configPath = join(configDirectory, 'nyc.json');
  const config = JSON.parse(await readFile(join(packageRoot, '.nycrc'), 'utf8'));
  await writeFile(
    configPath,
    JSON.stringify({ ...config, tempDir: raw, reportDir: report, clean: false, cache: false })
  );

  // Resolve all Mocha inputs once: CLI array merging otherwise puts coverage before ts-node.
  const mocha = loadOptions(process.argv.slice(2).length ? process.argv.slice(2) : ['test/**/*.test.ts']);
  const nodeOptions = []
    .concat(mocha['node-option'] || [])
    .filter((option) => !/^loader=.*(?:ts-node[/\\]esm(?:\.mjs)?|coverage-loader\.mjs)$/u.test(option));
  mocha['node-option'] = [
    ...nodeOptions,
    'loader=ts-node/esm',
    `loader=${pathToFileURL(join(packageRoot, 'scripts/coverage-loader.mjs')).href}`,
  ];
  const mochaArgs = ['--no-config', '--no-package'];
  for (const [key, value] of Object.entries(mocha)) {
    if (['_', 'config', 'package', '$0'].includes(key)) continue;
    for (const item of [].concat(value)) {
      if (typeof item === 'boolean') mochaArgs.push(item ? `--${key}` : `--no-${key}`);
      else mochaArgs.push(`--${key}`, String(item));
    }
  }
  mochaArgs.push(...mocha._);

  const child = spawn(
    process.execPath,
    [
      join(packageRoot, 'node_modules', 'nyc', 'bin', 'nyc.js'),
      '--nycrc-path',
      configPath,
      join(packageRoot, 'node_modules', 'mocha', 'bin', 'mocha.js'),
      ...mochaArgs,
    ],
    { cwd: packageRoot, stdio: 'inherit', env: { ...process.env, MOCHA_OPTIONS: '' } }
  );
  let spawnError;
  let forwardedSignal;
  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    child.kill(signal);
  };
  const interrupt = () => forwardSignal('SIGINT');
  const terminate = () => forwardSignal('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const outcome = await new Promise((resolveOutcome) => {
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', (code, signal) => resolveOutcome({ code, signal }));
    });
    const signal = outcome.signal ?? forwardedSignal;
    exitCode = spawnError ? 1 : outcome.code || (signal ? 128 + (constants.signals[signal] ?? 1) : 0);
    if (spawnError) console.error(spawnError);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
  // Validate NYC's merged, source-remapped API map before owned output is removed.
  const resolvedConfig = await loadNycConfig({ cwd: packageRoot, nycrcPath: configPath });
  const parser = Yargs([]);
  setupOptions(parser, null, packageRoot);
  const nycConfig = parser.config(resolvedConfig).parse([]);
  const map = await new NYC(nycConfig).getCoverageMapFromAllCoverageFiles();
  const eligible = map.files().filter((filename) => shouldInstrument(filename, nycConfig));
  if (!eligible.length) throw new Error('Unit-test coverage contains no eligible source file');
  if (!eligible.some((filename) => Object.keys(map.fileCoverageFor(filename).data.statementMap).length)) {
    throw new Error('Unit-test coverage contains no source statement entries');
  }
} catch (error) {
  exitCode ||= 1;
  console.error(error);
} finally {
  if (run) {
    try {
      for (const child of children.reverse()) await removeRunOwnedPath(run, child);
      await removeRunOwnedRoot(run);
    } catch (error) {
      exitCode ||= 1;
      console.error(`Unit-test cleanup refused; retained run root: ${run.root}`, error);
    }
  }
}
process.exitCode = exitCode;
