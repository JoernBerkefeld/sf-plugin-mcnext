import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../lib/filesystem/runOwnedTemp.js';

const packageRoot = resolve(import.meta.dirname, '..');

for (const mode of [
  'success',
  'failure',
  'spawn-failure',
  'setup-failure',
  'config-setup-failure',
  'signal',
  'junction',
  'junction-failure',
  'report-success',
  'report-failure',
  'empty-map',
  'excluded-map',
  'no-statements',
  'instrumentation-failure',
]) {
  test(`unit runner handles ${mode} without repository cleanup`, async (context) => {
    const fixtureRun = await createRunOwnedTemp('sf-mcnext-runner-test');
    const fixture = await createRunOwnedDirectory(fixtureRun, 'fixture');
    const outside = await createRunOwnedDirectory(fixtureRun, 'outside');
    const record = join(fixture, 'record.json');
    const preload = join(fixture, 'preload.mjs');
    try {
      const originalConfig = await readFile(join(packageRoot, '.nycrc'), 'utf8');
      const originalMocha = await readFile(join(packageRoot, '.mocharc.json'), 'utf8');
      await writeFile(join(outside, 'sentinel'), 'preserve');
      await writeFile(
        preload,
        `
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { loadNycConfig } from ${JSON.stringify(
          pathToFileURL(join(packageRoot, 'node_modules/@istanbuljs/load-nyc-config/index.js')).href
        )};
import assert from 'node:assert/strict';
const mode = process.env.RUNNER_MODE;
const cleanup = await import(${JSON.stringify(
          pathToFileURL(join(packageRoot, 'lib/filesystem/runOwnedTemp.js')).href
        )});
let ownedRun;
const freeze = Object.freeze;
Object.freeze = (value) => { if (mode.startsWith('junction') && value?.root?.includes('sf-mcnext-unit-tests-')) ownedRun = value; return freeze(value); };
process.once('beforeExit', async () => {
  if (!ownedRun) return;
  const paths = JSON.parse(readFileSync(process.env.RUNNER_RECORD, 'utf8'));
  if (!paths.link || !readFileSync(process.env.RUNNER_RECORD, 'utf8').includes('refused')) return;
  await fsPromises.rmdir(paths.link);
  await cleanup.removeRunOwnedPath(ownedRun, paths.raw);
  await cleanup.removeRunOwnedRoot(ownedRun);
});
const originalError = console.error;
console.error = (...args) => {
  if (String(args[0]).includes('cleanup refused') && mode.startsWith('junction')) {
    const paths = JSON.parse(readFileSync(process.env.RUNNER_RECORD, 'utf8'));
    paths.refused = true;
    writeFileSync(process.env.RUNNER_RECORD, JSON.stringify(paths));
  }
  originalError(...args);
};
const originalMkdir = fsPromises.mkdir;
fsPromises.mkdir = async (target, options) => {
  if (mode === 'setup-failure' && target.endsWith('report')) {
    writeFileSync(process.env.RUNNER_RECORD, JSON.stringify({ root: dirname(target), raw: join(dirname(target), 'raw') }));
    throw new Error('synthetic setup failure');
  }
  return originalMkdir(target, options);
};
const originalWriteFile = fsPromises.writeFile;
fsPromises.writeFile = async (target, ...args) => {
  if (mode === 'config-setup-failure' && target.endsWith('nyc.json')) {
    const root = dirname(dirname(target));
    writeFileSync(process.env.RUNNER_RECORD, JSON.stringify({root,raw:join(root,'raw'),report:join(root,'report'),config:dirname(target)}));
    throw new Error('synthetic config setup failure');
  }
  return originalWriteFile(target, ...args);
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = (file, args, options) => {
  const child = new EventEmitter();
  let subprocess;
  child.kill = (signal) => subprocess.kill(signal);
  setImmediate(async () => {
    try {
      assert.equal(file, process.execPath);
      assert.equal(args[0], join(process.env.RUNNER_ROOT, 'node_modules/nyc/bin/nyc.js'));
      assert.equal(args[1], '--nycrc-path');
      assert.equal(args[3], join(process.env.RUNNER_ROOT, 'node_modules/mocha/bin/mocha.js'));
      assert.deepEqual(args.slice(4,6), ['--no-config','--no-package']);
      assert.equal(args.at(-1), 'test/**/*.test.ts');
      const mochaArgs = args.slice(4);
      const values = (key) => mochaArgs.flatMap((arg,index) => arg === '--' + key ? [mochaArgs[index+1]] : []);
      assert.deepEqual(values('node-option'), ['trace-warnings', 'loader=ts-node/esm', 'loader=' + ${JSON.stringify(
        pathToFileURL(join(packageRoot, 'scripts/coverage-loader.mjs')).href
      )}]);
      assert.deepEqual(values('require'), ['ts-node/register']);
      assert.deepEqual(values('timeout'), ['600000']);
      assert.deepEqual(values('reporter'), ['spec']);
      assert.deepEqual(values('watch-extensions'), ['ts']);
      assert.ok(mochaArgs.includes('--recursive'));
      assert.equal(options.env.MOCHA_OPTIONS, '');
      assert.equal(options.cwd, process.env.RUNNER_ROOT);
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.shell, undefined);
      const config = await loadNycConfig({cwd: options.cwd, nycrcPath: args[2]});
      assert.equal(config.checkCoverage, true);
      for (const metric of ['lines','statements','functions','branches']) assert.equal(config[metric], 50);
      assert.equal(config.clean, false);
      assert.equal(config.cache, false);
      const root = dirname(config.tempDir);
      assert.equal(config.reportDir, join(root, 'report'));
      assert.equal(dirname(args[2]), join(root, 'config'));
      assert.notEqual(dirname(args[2]), config.tempDir);
      const original = JSON.parse(readFileSync(join(options.cwd, '.nycrc'), 'utf8'));
      assert.deepEqual(JSON.parse(readFileSync(args[2], 'utf8')), {...original,tempDir:config.tempDir,reportDir:config.reportDir,clean:false,cache:false});
      const link = join(config.tempDir, 'link');
      writeFileSync(process.env.RUNNER_RECORD, JSON.stringify({root,raw:config.tempDir,report:config.reportDir,config:dirname(args[2]),link}));
      if (mode.startsWith('junction')) {
        try { await fsPromises.symlink(process.env.RUNNER_OUTSIDE, link, 'junction'); }
        catch(error) { if (['EPERM','EACCES'].includes(error.code)) { console.error('LINK_PRIVILEGE_PENDING'); child.emit('close', 0, null); return; } throw error; }
      }
      const actualReport = mode.startsWith('report-');
      if (mode !== 'empty-map') {
        const source = join(options.cwd, mode === 'excluded-map' ? 'test/excluded.ts' : 'src/index.ts');
        const count = mode === 'report-success' ? 1 : 0;
        const location = {start:{line:1,column:0},end:{line:1,column:1}};
        const coverage = {path:source,statementMap:{'0':location},fnMap:{'0':{name:'synthetic',decl:location,loc:location,line:1}},branchMap:{'0':{type:'if',loc:location,line:1,locations:[location,location]}},s:{'0':count},f:{'0':count},b:{'0':[count,count]}};
        if (mode === 'no-statements') { coverage.statementMap = {}; coverage.s = {}; }
        writeFileSync(join(config.tempDir, 'synthetic-coverage.json'), JSON.stringify({[source]:coverage}));
        assert.deepEqual(await fsPromises.readdir(config.tempDir), mode.startsWith('junction') ? ['link', 'synthetic-coverage.json'] : ['synthetic-coverage.json']);
      }
      subprocess = originalSpawn(mode === 'spawn-failure' ? join(root, 'missing-executable') : process.execPath,
        actualReport ? [args[0], 'report', '--nycrc-path', args[2], '--reporter', 'json-summary'] :
        mode === 'signal' ? ['-e', 'setInterval(() => {}, 1000)'] : mode === 'instrumentation-failure' ? ['--input-type=module', '-e', 'process.env.NYC_CONFIG = ' + JSON.stringify(JSON.stringify({...config, extension:['.ts']})) + '; const {load} = await import(' + ${JSON.stringify(
          JSON.stringify(pathToFileURL(join(packageRoot, 'scripts/coverage-loader.mjs')).href)
        )} + '); await load(' + JSON.stringify(${JSON.stringify(
          pathToFileURL(join(packageRoot, 'src/index.ts')).href
        )}) + ', {}, async () => ({format:"module",source:"not valid JavaScript"}));'] : ['-e', 'process.exit(' + (mode.endsWith('failure') ? 37 : 0) + ')'],
        {cwd:options.cwd,stdio:'inherit'});
      subprocess.on('error', (error) => child.emit('error', error));
      subprocess.on('close', (code, signal) => {
        if (actualReport) {
          try {
            const summary = JSON.parse(readFileSync(join(config.reportDir, 'coverage-summary.json'), 'utf8'));
            for (const metric of ['lines','statements','functions','branches']) assert.equal(summary.total[metric].pct, mode === 'report-success' ? 100 : 0);
            assert.equal(code, mode === 'report-success' ? 0 : 1);
          } catch(error) { child.emit('error', error); child.emit('close', 91, null); return; }
        }
        child.emit('close', code, signal);
      });
      if (mode === 'signal') subprocess.once('spawn', () => process.emit('SIGTERM'));
    } catch(error) { child.emit('error', error); child.emit('close', 91, null); }
  });
  return child;
};
syncBuiltinESMExports();
`
      );
      const result = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(preload).href, 'scripts/run-unit-tests.mjs'],
        {
          cwd: packageRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            MOCHA_OPTIONS: '--node-option=trace-warnings --node-option=loader=ts-node/esm',
            RUNNER_MODE: mode,
            RUNNER_ROOT: packageRoot,
            RUNNER_RECORD: record,
            RUNNER_OUTSIDE: outside,
          },
        }
      );
      assert.ifError(result.error);
      assert.doesNotMatch(result.stderr, /Invalid argument to coverage constructor/u);
      if (mode === 'report-failure') {
        assert.match(result.stderr, /does not meet global threshold/u);
        assert.doesNotMatch(result.stderr, /no eligible|no source statement/u);
      }
      if (['empty-map', 'excluded-map'].includes(mode)) assert.match(result.stderr, /no eligible source file/u);
      if (mode === 'no-statements') assert.match(result.stderr, /no source statement entries/u);
      if (mode === 'instrumentation-failure') assert.match(result.stderr, /Unexpected|Missing/u);
      const paths = JSON.parse(await readFile(record, 'utf8'));
      assert.equal(await readFile(join(packageRoot, '.nycrc'), 'utf8'), originalConfig);
      assert.equal(await readFile(join(packageRoot, '.mocharc.json'), 'utf8'), originalMocha);
      assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'preserve');
      if (mode.startsWith('junction') && !result.stderr.includes('LINK_PRIVILEGE_PENDING')) {
        assert.equal(result.status, mode === 'junction-failure' ? 37 : 1, result.stderr);
        assert.match(result.stderr, /cleanup refused; retained run root/u);
        assert.equal(paths.refused, true);
        assert.equal(
          existsSync(paths.root),
          false,
          'synthetic owner must dismantle its junction and clean its fixture'
        );
      } else {
        if (mode.startsWith('junction')) context.skip('junction privileges unavailable; explicitly pending');
        const expected =
          mode === 'failure' || mode === 'junction-failure'
            ? 37
            : mode === 'signal'
            ? 143
            : mode === 'setup-failure' || mode === 'config-setup-failure' || mode === 'report-failure'
            ? 1
            : ['spawn-failure', 'empty-map', 'excluded-map', 'no-statements', 'instrumentation-failure'].includes(mode)
            ? 1
            : 0;
        assert.equal(result.status, expected, result.stderr);
        assert.equal(existsSync(paths.root), false, 'owned root must be removed');
        assert.equal(existsSync(paths.raw), false, 'owned raw child must be removed');
        if (paths.report) assert.equal(existsSync(paths.report), false, 'owned report child must be removed');
        if (paths.config) assert.equal(existsSync(paths.config), false, 'owned config child must be removed');
      }
    } finally {
      await removeRunOwnedPath(fixtureRun, fixture);
      if (existsSync(outside)) await removeRunOwnedPath(fixtureRun, outside);
      await removeRunOwnedRoot(fixtureRun);
    }
  });
}

test('normal runner collects remapped dependencyGraph TS coverage and enforces real thresholds', async () => {
  const run = await createRunOwnedTemp('sf-mcnext-normal-coverage-test');
  const fixture = await createRunOwnedDirectory(run, 'fixture');
  const preload = join(fixture, 'preload.mjs');
  const record = join(fixture, 'coverage.json');
  const filename = join(packageRoot, 'src/capabilities/dependencyGraph.ts');
  try {
    await writeFile(
      preload,
      `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import NYC from ${JSON.stringify(pathToFileURL(join(packageRoot, 'node_modules/nyc/index.js')).href)};
const originalRead = fs.readFile;
fs.readFile = async (filename, ...args) => {
  const contents = await originalRead(filename, ...args);
  if (String(filename).endsWith('.nycrc')) {
    const config = JSON.parse(contents);
    for (const metric of ['lines','statements','functions','branches']) config[metric] = Number(process.env.RUNNER_THRESHOLD);
    return JSON.stringify({...config,extension:['.ts'],include:['src/capabilities/dependencyGraph.ts'], 'produce-source-map':true,'es-modules':true});
  }
  return contents;
};
const originalMap = NYC.prototype.getCoverageMapFromAllCoverageFiles;
NYC.prototype.getCoverageMapFromAllCoverageFiles = async function(...args) {
  const map = await originalMap.apply(this, args);
  await fs.writeFile(process.env.RUNNER_RECORD, JSON.stringify(map));
  return map;
};
syncBuiltinESMExports();
`
    );
    for (const threshold of [50, 99]) {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          'scripts/run-unit-tests.mjs',
          'test/capabilities/dependencyGraph.test.ts',
        ],
        {
          cwd: packageRoot,
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, MOCHA_OPTIONS: '', RUNNER_RECORD: record, RUNNER_THRESHOLD: String(threshold) },
        }
      );
      assert.ifError(result.error);
      assert.equal(result.status, threshold === 50 ? 0 : 1, result.stdout + result.stderr);
      assert.match(result.stdout, /7 passing/u);
      assert.doesNotMatch(result.stderr, /no eligible|no source statement/u);
      if (threshold === 99) assert.match(result.stderr, /does not meet global threshold/u);
      const map = JSON.parse(await readFile(record, 'utf8'));
      assert.deepEqual(
        Object.keys(map).map((file) => resolve(file)),
        [filename]
      );
      const statements = Object.values(map[Object.keys(map)[0]].statementMap);
      assert.ok(statements.length > 0);
      const lines = (await readFile(filename, 'utf8')).split('\n');
      assert.ok(statements.every((location) => location.start.line <= lines.length));
      assert.ok(
        statements.some((location) => lines[location.start.line - 1].includes('assertPortableIdentity(identity)'))
      );
    }
  } finally {
    await removeRunOwnedPath(run, fixture);
    await removeRunOwnedRoot(run);
  }
});

test('Wireit normal test graph reaches runner and fresh compile without cached coverage success', async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'wireit');
  assert.ok(pkg.wireit.test.dependencies.includes('test:only'));
  assert.equal(pkg.wireit['test:only'].command, 'node scripts/run-unit-tests.mjs');
  assert.ok(pkg.wireit['test:only'].dependencies.includes('manifest'));
  assert.ok(pkg.wireit.manifest.dependencies.includes('compile'));
  assert.equal(Object.hasOwn(pkg.wireit['test:only'], 'output'), false);
  assert.ok(pkg.wireit['test:only'].files.includes('scripts/run-unit-tests.mjs'));
  const regressions = pkg.wireit['test:package-parser'];
  assert.ok(regressions.dependencies.includes('compile'));
  for (const file of [
    'parse-npm-pack-output.test.mjs',
    'verify-package-lifecycle.test.mjs',
    'run-unit-tests.test.mjs',
  ]) {
    assert.ok(regressions.command.includes(`scripts/${file}`));
    assert.ok(regressions.files.includes(`scripts/${file}`));
  }
});
