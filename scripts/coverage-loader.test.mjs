import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import convertSourceMap from 'convert-source-map';
import NYC from 'nyc';
import { load, shouldInstrument } from './coverage-loader.mjs';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../lib/filesystem/runOwnedTemp.js';

const packageRoot = resolve(import.meta.dirname, '..');
const filename = join(packageRoot, 'src/capabilities/dependencyGraph.ts');
const config = {
  cwd: packageRoot,
  extension: ['.ts'],
  include: ['src/capabilities/dependencyGraph.ts'],
  exclude: [],
  esModules: true,
  produceSourceMap: true,
  ignoreClassMethod: ['ignored'],
};

// Direct loader checks use the same resolved configuration handed to NYC's child process.
test('loader delegates first, filters resolved eligibility, preserves maps/settings and fails closed', async () => {
  const original = process.env.NYC_CONFIG;
  process.env.NYC_CONFIG = JSON.stringify(config);
  try {
    assert.equal(shouldInstrument(filename, config), true);
    assert.equal(shouldInstrument(filename, { ...config, exclude: ['src/**'] }), false);
    assert.equal(shouldInstrument(filename, { ...config, extension: ['.jsx'] }), false);
    assert.equal(shouldInstrument(join(packageRoot, 'test/example.ts'), { ...config, include: [] }), false);
    const source = 'export class Example { ignored() { return 1; } included() { return 2; } }';
    const inputMap = {
      version: 3,
      file: filename,
      sources: [filename],
      sourcesContent: ['// original TypeScript\n' + source],
      names: [],
      mappings: 'AACA',
    };
    let delegated = false;
    const loaded = await load(pathToFileURL(filename).href, {}, async () => {
      delegated = true;
      return {
        format: 'module',
        source: Buffer.from(source + '\n' + convertSourceMap.fromObject(inputMap).toComment()),
        shortCircuit: true,
      };
    });
    assert.equal(delegated, true);
    assert.equal(loaded.shortCircuit, true);
    assert.match(loaded.source, /__coverage__/u);
    assert.match(loaded.source, /ignored\(\)\s*\{\s*return 1;/u);
    assert.match(loaded.source, /included\(\)\s*\{\s*cov_\w+\(\)\.f\[0\]\+\+/u);
    const outputMap = convertSourceMap.fromSource(loaded.source).toObject();
    assert.ok(outputMap.sources.includes(filename));
    assert.ok(outputMap.sourcesContent.some((content) => content.includes('original TypeScript')));
    const untouched = { format: 'module', source: 'not valid JavaScript' };
    assert.equal(
      await load(pathToFileURL(join(packageRoot, 'test/excluded.ts')).href, {}, async () => untouched),
      untouched
    );
    await assert.rejects(
      load(pathToFileURL(filename).href, {}, async () => untouched),
      /Unexpected|Missing/u
    );
    await assert.rejects(
      load(pathToFileURL(filename).href, {}, async () => {
        throw new Error('nextLoad failed');
      }),
      /nextLoad failed/u
    );
  } finally {
    if (original === undefined) delete process.env.NYC_CONFIG;
    else process.env.NYC_CONFIG = original;
  }
});

test('real dependencyGraph ESM tests collect original TS coverage and enforce 50/99 thresholds', async () => {
  const run = await createRunOwnedTemp('sf-mcnext-esm-coverage-test');
  const children = [];
  try {
    const raw = await createRunOwnedDirectory(run, 'raw');
    children.push(raw);
    const report = await createRunOwnedDirectory(run, 'report');
    children.push(report);
    const result = spawnSync(
      process.execPath,
      [
        join(packageRoot, 'node_modules/nyc/bin/nyc.js'),
        '--clean=false',
        '--cache=false',
        '--temp-dir',
        raw,
        '--report-dir',
        report,
        '--extension',
        '.ts',
        '--include',
        'src/capabilities/dependencyGraph.ts',
        '--produce-source-map',
        '--es-modules',
        '--check-coverage',
        '--lines',
        '50',
        '--statements',
        '50',
        '--functions',
        '50',
        '--branches',
        '50',
        process.execPath,
        '--loader',
        'ts-node/esm',
        '--loader',
        './scripts/coverage-loader.mjs',
        join(packageRoot, 'node_modules/mocha/bin/mocha.js'),
        '--no-config',
        '--require',
        'ts-node/register',
        '--timeout',
        '600000',
        '--reporter',
        'spec',
        'test/capabilities/dependencyGraph.test.ts',
      ],
      { cwd: packageRoot, encoding: 'utf8', timeout: 120_000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /7 passing/u);
    const nyc = new NYC({ ...config, tempDir: raw, reportDir: report, clean: false, cache: false });
    const map = await nyc.getCoverageMapFromAllCoverageFiles();
    assert.deepEqual(
      map.files().map((file) => resolve(file)),
      [filename]
    );
    const coverage = map.fileCoverageFor(map.files()[0]);
    assert.ok(Object.keys(coverage.data.statementMap).length > 0);
    const originalLines = (await readFile(filename, 'utf8')).split('\n');
    assert.ok(
      Object.values(coverage.data.statementMap).every((location) => location.start.line <= originalLines.length)
    );
    assert.ok(
      Object.values(coverage.data.statementMap).some((location) =>
        originalLines[location.start.line - 1].includes('assertPortableIdentity(identity)')
      )
    );
    for (const metric of ['lines', 'statements', 'functions', 'branches']) {
      assert.ok(coverage.toSummary()[metric].pct >= 50, `${metric} must meet unchanged threshold`);
    }
    const priorExit = process.exitCode;
    try {
      process.exitCode = 0;
      await nyc.checkCoverage({ branches: 99 }, false);
      assert.equal(process.exitCode, 1, 'real branch gaps must fail 99%');
    } finally {
      process.exitCode = priorExit;
    }
  } finally {
    for (const child of children.reverse()) await removeRunOwnedPath(run, child);
    await removeRunOwnedRoot(run);
  }
});
