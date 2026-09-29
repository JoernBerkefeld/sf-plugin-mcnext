import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNpmPackOutput } from './parse-npm-pack-output.mjs';

const packResult = [{ filename: 'sf-plugin-mcnext-0.6.1.tgz' }];

test('parses clean npm pack JSON output', () => {
  assert.deepEqual(parseNpmPackOutput(`${JSON.stringify(packResult, null, 2)}\n`), packResult);
});

test('parses npm pack JSON output surrounded by lifecycle stdout', () => {
  const output = [
    '> sf-plugin-mcnext@0.6.1 prepack',
    '> tsc && npm run lint && oclif manifest',
    '✅ Ran 0 scripts and skipped 1 in 12ms.',
    JSON.stringify(packResult, null, 2),
    '> sf-plugin-mcnext@0.6.1 postpack',
    '> sf-clean --ignore-signing-artifacts',
    '',
  ].join('\n');

  assert.deepEqual(parseNpmPackOutput(output), packResult);
});

test('ignores unrelated bracketed lifecycle output', () => {
  const output = `[prepack] generated manifest\n${JSON.stringify(packResult)}\n[postpack] cleaned lib\n`;
  assert.deepEqual(parseNpmPackOutput(output), packResult);
});

test('rejects ambiguous valid pack result arrays', () => {
  assert.throws(
    () => parseNpmPackOutput(`${JSON.stringify(packResult)}\n${JSON.stringify(packResult)}\n`),
    /exactly one valid JSON result array/u
  );
});

test('rejects missing, malformed, and wrong-shaped payloads', () => {
  assert.throws(() => parseNpmPackOutput('[{"filename":"broken.tgz"}\n'), /exactly one valid JSON result array/u);
  assert.throws(() => parseNpmPackOutput('{"filename":"not-an-array.tgz"}\n'), /exactly one valid JSON result array/u);
  assert.throws(() => parseNpmPackOutput('[{"name":"missing-filename"}]\n'), /exactly one valid JSON result array/u);
  assert.throws(() => parseNpmPackOutput('prepack completed without JSON\n'), /exactly one valid JSON result array/u);
});
