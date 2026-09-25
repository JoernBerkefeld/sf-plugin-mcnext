import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { basename, join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const workDir = mkdtempSync(join(tmpdir(), 'sf-plugin-mcnext-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'npm_execpath is required to run the package lifecycle');

execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: packageRoot, stdio: 'inherit' });
rmSync(join(packageRoot, 'lib'), { force: true, recursive: true });
rmSync(join(packageRoot, 'oclif.manifest.json'), { force: true });

const packedFiles = execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', workDir], {
  cwd: packageRoot,
  encoding: 'utf8',
});

try {
  const [packResult] = JSON.parse(packedFiles);
  assert.ok(packResult?.filename, 'npm pack did not report a package filename');

  const tarball = join(workDir, basename(packResult.filename));
  const entries = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean);
  const entrySet = new Set(entries);

  assert.ok(
    entries.some((entry) => entry.startsWith('package/lib/commands/')),
    'compiled commands are missing'
  );
  assert.ok(entrySet.has('package/lib/index.js'), 'package entry point is missing');
  assert.ok(entrySet.has('package/oclif.manifest.json'), 'oclif manifest is missing');

  const manifestText = execFileSync('tar', ['-xOf', tarball, 'package/oclif.manifest.json'], { encoding: 'utf8' });
  assert.ok(manifestText.trim().length > 2, 'oclif manifest is empty');
  const manifest = JSON.parse(manifestText);
  const commandIds = Object.keys(manifest.commands ?? {}).sort();
  const expectedCommandIds = [
    'mcnext:campaign:config',
    'mcnext:data-graph:metadata',
    'mcnext:email-template:show',
    'mcnext:email:send-definition:show',
    'mcnext:flow:source',
    'mcnext:identity-resolution:export',
    'mcnext:identity-resolution:list',
    'mcnext:identity-resolution:plan',
    'mcnext:identity-resolution:show',
    'mcnext:list:types',
    'mcnext:migration:plan',
    'mcnext:segment:definition:create',
    'mcnext:segment:members:export',
    'mcnext:segment:records:export',
  ].sort();
  assert.deepEqual(commandIds, expectedCommandIds, 'manifest public command IDs do not match the Phase 2 contract');

  execFileSync('tar', ['-xf', tarball, '-C', workDir, 'package/lib/registry/registry.js']);
  const registryUrl = pathToFileURL(join(workDir, 'package', 'lib', 'registry', 'registry.js'));
  const { MCN_TYPES } = await import(registryUrl.href);
  const registryContract = Object.fromEntries(
    MCN_TYPES.map((type) => [type.name, { operations: type.operations, provider: type.provider, state: type.state }])
  );
  assert.deepEqual(
    registryContract,
    {
      marketSegmentMember: { operations: ['export'], provider: 'mcnext', state: 'implemented' },
      listEmail: { operations: ['retrieve'], provider: 'core-sf', state: 'delegated' },
      emailTemplate: { operations: ['retrieve'], provider: 'mcnext', state: 'implemented' },
      campaign: { operations: ['retrieve', 'create', 'update'], provider: 'mcnext', state: 'implemented' },
      dataGraph: { operations: ['retrieve'], provider: 'mcnext', state: 'implemented' },
      identityResolution: {
        operations: ['list', 'retrieve', 'export', 'plan'],
        provider: 'mcnext',
        state: 'implemented',
      },
      cmsContent: { operations: ['export'], provider: 'cms-service', state: 'conditional' },
      flow: { operations: ['retrieve', 'create', 'update'], provider: 'mcnext', state: 'implemented' },
      flowDefinition: { operations: ['retrieve', 'deploy'], provider: 'core-sf', state: 'delegated' },
      flowTest: { operations: ['retrieve', 'deploy'], provider: 'core-sf', state: 'delegated' },
      managedContentType: { operations: ['retrieve', 'deploy'], provider: 'core-sf', state: 'delegated' },
      contentTypeBundle: { operations: ['retrieve', 'deploy'], provider: 'core-sf', state: 'delegated' },
      marketSegmentDefinition: { operations: ['create'], provider: 'mcnext', state: 'implemented' },
      marketSegmentRecord: { operations: ['export'], provider: 'core-sf', state: 'delegated' },
    },
    'registry contract does not match the Phase 2 package surface'
  );

  const forbidden = [
    /^package\/(?:\.cursor|\.sf|\.wireit|coverage|tmp)(?:\/|$)/u,
    /^package\/(?:_mcnext-probe\.mjs|_probe-output)(?:\/|$)/u,
    /(?:^|\/)(?:\.env(?:\..*)?|.*credential.*|.*evidence.*)$/iu,
    /^package\/(?:mcp\.json|\.mcp\.json)$/u,
  ];
  const forbiddenEntries = entries.filter((entry) => forbidden.some((pattern) => pattern.test(entry)));
  assert.deepEqual(forbiddenEntries, [], `forbidden package content: ${forbiddenEntries.join(', ')}`);

  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports, './lib/index.js', 'package export must point to the compiled entry point');
  process.stdout.write(`Verified ${basename(tarball)} (${entries.length} files, ${commandIds.length} commands).\n`);
} finally {
  rmSync(workDir, { force: true, recursive: true });
}
