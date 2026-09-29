import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const legacyConsumers = [
  ['nyc', 'nyc/package.json'],
  ['nyc glob', 'nyc/node_modules/glob/package.json'],
  ['mocha', 'mocha/package.json'],
  ['mocha glob', 'mocha/node_modules/glob/package.json'],
];

test('legacy test consumers resolve callable CommonJS minimatch', async (context) => {
  for (const [name, packagePath] of legacyConsumers) {
    await context.test(name, () => {
      const consumerRoot = dirname(require.resolve(packagePath));
      const minimatchPath = require.resolve('minimatch', { paths: [consumerRoot] });
      const minimatch = require(minimatchPath);

      assert.equal(typeof minimatch, 'function', `${name} resolved non-callable minimatch at ${minimatchPath}`);
      assert.equal(minimatch('src/example.ts', '{src,test}/**/*.ts'), true, `${name} failed src brace match`);
      assert.equal(minimatch('test/example.ts', '{src,test}/**/*.ts'), true, `${name} failed test brace match`);
      assert.equal(minimatch('lib/example.ts', '{src,test}/**/*.ts'), false, `${name} matched outside brace roots`);
    });
  }
});
