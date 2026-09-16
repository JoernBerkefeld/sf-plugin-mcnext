import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { Org } from '@salesforce/core';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import MigrationPlanCommand, { cmsPlanningServices } from '../../../../src/commands/mcnext/migration/plan.js';
import { cloneFixture, validExportFixture, validInfoFixture } from '../../../cms/contractFixtures.js';

function fakeOrg(orgId: string, maximum = '67.0'): Org {
  return {
    getOrgId: () => orgId,
    getConnection: () => ({
      retrieveMaxApiVersion: async () => maximum,
      request: async () => ({}),
    }),
  } as unknown as Org;
}

describe('mcnext migration plan', () => {
  const $$ = new TestContext();
  let directory: string;
  let ux: ReturnType<typeof stubSfCommandUx>;

  beforeEach(async () => {
    ux = stubSfCommandUx($$.SANDBOX);
    directory = await mkdtemp(join(tmpdir(), 'mcnext-command-plan-'));
    $$.SANDBOX.stub(Org, 'create').callsFake(async (options?: object) => {
      const aliasOrUsername = (options as { aliasOrUsername?: string } | undefined)?.aliasOrUsername;
      return fakeOrg(aliasOrUsername === 'source' ? '00Dsource' : '00Dtarget');
    });
  });

  afterEach(async () => {
    $$.restore();
    await rm(directory, { recursive: true, force: true });
  });

  it('writes and returns a read-only deterministic plan contract', async () => {
    const output = join(directory, 'migration-plan.json');
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
    ]);
    const plan = JSON.parse(await readFile(output, 'utf8')) as { executableTargetPayloads: unknown[]; mode: string };

    expect(result).to.include({
      outputFile: output,
      sourceOrgId: '00Dsource',
      targetOrgId: '00Dtarget',
      preflightPassed: true,
      readOnly: true,
      deferredCmsDependencies: 0,
    });
    expect(result.inventoryItems).to.equal(66);
    expect(plan).to.include({ mode: 'read-only' });
    expect(plan.executableTargetPayloads).to.deep.equal([]);
  });

  it('accepts only minimal opaque CMS evidence', async () => {
    const evidence = join(directory, 'cms.json');
    const output = join(directory, 'migration-plan.json');
    await writeFile(
      evidence,
      JSON.stringify([
        {
          owner: 'cms-service',
          status: 'deferred: cms-service-contract',
          sourceReference: 'opaque-source-id',
          blockedOperation: 'listEmail.deploy',
        },
      ]),
      'utf8'
    );
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
      '--cms-evidence-file',
      evidence,
    ]);
    expect(result.deferredCmsDependencies).to.equal(1);
  });

  it('rejects CMS planning companions without --cms-plan and requires both companions with it', async () => {
    const base = ['--source-org', 'source', '--target-org', 'target', '--output-file', join(directory, 'plan.json')];
    for (const args of [
      [...base, '--cms-workspace-map', join(directory, 'map.json')],
      [...base, '--cms-export-dir', join(directory, 'export')],
      [...base, '--cms-plan', '--cms-workspace-map', join(directory, 'map.json')],
      [...base, '--cms-plan', '--cms-export-dir', join(directory, 'export')],
    ]) {
      let caught: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- each argv relationship is independently asserted
        await MigrationPlanCommand.run(args);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).name).to.equal('InvalidCmsPlanningFlagsError');
    }
  });

  it('keeps CMS-independent and legacy evidence modes isolated from CMS subprocesses', async () => {
    const info = $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').rejects(new Error('must not run'));
    const exportCms = $$.SANDBOX.stub(cmsPlanningServices, 'runExport').rejects(new Error('must not run'));
    const evidence = join(directory, 'cms.json');
    await writeFile(evidence, '[]', 'utf8');
    await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      join(directory, 'plan.json'),
      '--cms-evidence-file',
      evidence,
    ]);
    expect(info.called).to.equal(false);
    expect(exportCms.called).to.equal(false);
  });

  it('keeps successful experimental CMS evidence ownership-uncertain without mutation', async () => {
    const workspaceMap = join(directory, 'map.json');
    const evidenceFile = join(directory, 'cms-evidence.json');
    const exportDirectory = join(directory, 'export');
    const output = join(directory, 'plan.json');
    await writeFile(workspaceMap, '{"version":1,"workspaces":{"0ZuSource":"0ZuTarget"}}\n', 'utf8');
    await writeFile(
      evidenceFile,
      JSON.stringify([
        {
          owner: 'cms-service',
          status: 'deferred: cms-service-contract',
          sourceReference: ' OPAQUE:Case-Sensitive/Value== ',
          blockedOperation: 'listEmail.deploy',
        },
      ]),
      'utf8'
    );
    const info = cloneFixture(validInfoFixture);
    const exported = cloneFixture(validExportFixture);
    exported.provenance.sourceOrgId = '00Dsource';
    const packageHash = exported.result!.workspaces[0].artifact.manifestSha256;
    $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').resolves({
      envelope: info,
      capabilities: { bulkExport: 'implemented', externalReferenceCorrelation: 'experimental', experimental: true },
    });
    const exportStub = $$.SANDBOX.stub(cmsPlanningServices, 'runExport').resolves(exported);
    $$.SANDBOX.stub(cmsPlanningServices, 'validatePackage').resolves({
      sourceWorkspaceId: '0ZuSource',
      artifactPath: join(exportDirectory, 'Marketing Workspace'),
      manifestPath: join(exportDirectory, 'Marketing Workspace', 'manifest.json'),
      packageManifestSha256: packageHash,
      sourceOrgId: '00Dsource',
      pluginVersion: '0.4.0',
      exportSetId: exported.provenance.exportSetId!,
      correlations: exported.result!.externalReferenceCorrelations,
    });

    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
      '--cms-evidence-file',
      evidenceFile,
      '--cms-plan',
      '--cms-workspace-map',
      workspaceMap,
      '--cms-export-dir',
      exportDirectory,
    ]);
    const plan = JSON.parse(await readFile(output, 'utf8')) as {
      cmsPlanning: {
        state: string;
        experimental: boolean;
        correlations: Array<{ sourceReference: string }>;
        executablePayloads: unknown[];
        imports: unknown[];
        rewrites: unknown[];
        mutations: unknown[];
      };
      executableTargetPayloads: unknown[];
    };
    expect(exportStub.calledOnceWithExactly('source', exportDirectory)).to.equal(true);
    expect(result.cmsPlanning).to.deep.equal({
      state: 'ownership-uncertain',
      experimental: true,
      readyRoutes: 0,
      blockedRoutes: 1,
    });
    expect(plan.cmsPlanning).to.include({ state: 'ownership-uncertain', experimental: true });
    expect(plan.cmsPlanning.correlations[0].sourceReference).to.equal(' OPAQUE:Case-Sensitive/Value== ');
    expect(plan.executableTargetPayloads).to.deep.equal([]);
    expect(plan.cmsPlanning.executablePayloads).to.deep.equal([]);
    expect(plan.cmsPlanning.imports).to.deep.equal([]);
    expect(plan.cmsPlanning.rewrites).to.deep.equal([]);
    expect(plan.cmsPlanning.mutations).to.deep.equal([]);
    expect(ux.log.args.flat().join(' '))
      .to.include('ownership-uncertain (experimental)')
      .and.to.include('ready routes: 0');
    expect(ux.warn.args.flat().join(' ')).to.include('CMS-dependent planning is not ready');
  });

  it('reports ownership uncertainty instead of readiness without a known dependent edge', async () => {
    const workspaceMap = join(directory, 'ownership-map.json');
    const output = join(directory, 'ownership.json');
    await writeFile(workspaceMap, '{"version":1,"workspaces":{"0ZuSource":"0ZuTarget"}}', 'utf8');
    const exported = cloneFixture(validExportFixture);
    exported.provenance.sourceOrgId = '00Dsource';
    $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').resolves({
      envelope: cloneFixture(validInfoFixture),
      capabilities: { bulkExport: 'implemented', externalReferenceCorrelation: 'experimental', experimental: true },
    });
    $$.SANDBOX.stub(cmsPlanningServices, 'runExport').resolves(exported);
    $$.SANDBOX.stub(cmsPlanningServices, 'validatePackage').resolves({
      sourceWorkspaceId: '0ZuSource',
      artifactPath: 'a',
      manifestPath: 'a/manifest.json',
      packageManifestSha256: exported.result!.workspaces[0].artifact.manifestSha256,
      sourceOrgId: '00Dsource',
      pluginVersion: '0.4.0',
      exportSetId: exported.provenance.exportSetId!,
      correlations: exported.result!.externalReferenceCorrelations,
    });
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
      '--cms-plan',
      '--cms-workspace-map',
      workspaceMap,
      '--cms-export-dir',
      join(directory, 'ownership-export'),
    ]);
    expect(result.cmsPlanning).to.deep.equal({
      state: 'ownership-uncertain',
      experimental: true,
      readyRoutes: 0,
      blockedRoutes: 1,
    });
  });

  for (const level of ['workspace', 'aggregate'] as const) {
    for (const status of ['partial', 'failed', 'blocked'] as const) {
      it(`does not collapse ${level} ${status} export into ownership uncertainty`, async () => {
        const workspaceMap = join(directory, 'map.json');
        const output = join(directory, 'plan.json');
        await writeFile(workspaceMap, '{"version":1,"workspaces":{"0ZuSource":"0ZuTarget"}}');
        const exported = cloneFixture(validExportFixture);
        exported.provenance.sourceOrgId = '00Dsource';
        if (level === 'workspace') exported.result!.workspaces[0].status = status;
        else exported.status = status;
        $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').resolves({
          envelope: cloneFixture(validInfoFixture),
          capabilities: { bulkExport: 'implemented', externalReferenceCorrelation: 'experimental', experimental: true },
        });
        $$.SANDBOX.stub(cmsPlanningServices, 'runExport').resolves(exported);
        const validate = $$.SANDBOX.stub(cmsPlanningServices, 'validatePackage').resolves({
          sourceWorkspaceId: '0ZuSource',
          artifactPath: 'a',
          manifestPath: 'a/manifest.json',
          packageManifestSha256: exported.result!.workspaces[0].artifact.manifestSha256,
          sourceOrgId: '00Dsource',
          pluginVersion: '0.4.0',
          exportSetId: exported.provenance.exportSetId!,
          correlations: [],
        });
        const result = await MigrationPlanCommand.run([
          '--source-org',
          'source',
          '--target-org',
          'target',
          '--output-file',
          output,
          '--cms-plan',
          '--cms-workspace-map',
          workspaceMap,
          '--cms-export-dir',
          join(directory, 'export'),
        ]);
        expect(result.cmsPlanning!.state).to.equal('blocked');
        if (level === 'workspace') expect(validate.called).to.equal(false);
        expect(ux.log.args.flat().join(' ')).to.include('blocked (experimental)');
      });
    }
  }

  for (const scenario of ['valid', 'invalid', 'missing-route'] as const) {
    it(`sanitizes every persisted diagnostic field for ${scenario} packages`, async () => {
      const workspaceMap = join(directory, 'map.json');
      const output = join(directory, 'plan.json');
      await writeFile(
        workspaceMap,
        JSON.stringify({
          version: 1,
          workspaces: { [scenario === 'missing-route' ? 'other' : '0ZuSource']: '0ZuTarget' },
        })
      );
      const exported = cloneFixture(validExportFixture);
      exported.provenance.sourceOrgId = '00Dsource';
      const unsafe = {
        code: 'token=code-secret',
        message: 'Authorization: Bearer bearer-secret /var/private/evidence',
        scope: 'C:/private/scope-secret',
        reference: '\\\\server\\share\\reference-secret',
      };
      exported.diagnostics.warnings.push(unsafe);
      exported.result!.workspaces[0].diagnostics.warnings.push(unsafe);
      $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').resolves({
        envelope: cloneFixture(validInfoFixture),
        capabilities: { bulkExport: 'implemented', externalReferenceCorrelation: 'experimental', experimental: true },
      });
      $$.SANDBOX.stub(cmsPlanningServices, 'runExport').resolves(exported);
      const validate = $$.SANDBOX.stub(cmsPlanningServices, 'validatePackage');
      if (scenario === 'invalid') validate.rejects(new Error('token=exception-secret C:\\private\\exception-path'));
      else
        validate.resolves({
          sourceWorkspaceId: '0ZuSource',
          artifactPath: 'a',
          manifestPath: 'a/manifest.json',
          packageManifestSha256: exported.result!.workspaces[0].artifact.manifestSha256,
          sourceOrgId: '00Dsource',
          pluginVersion: '0.4.0',
          exportSetId: exported.provenance.exportSetId!,
          correlations: [],
        });
      await MigrationPlanCommand.run([
        '--source-org',
        'source',
        '--target-org',
        'target',
        '--output-file',
        output,
        '--cms-plan',
        '--cms-workspace-map',
        workspaceMap,
        '--cms-export-dir',
        join(directory, 'export'),
      ]);
      const written = await readFile(output, 'utf8');
      for (const forbidden of [
        'code-secret',
        'bearer-secret',
        '/var/private',
        'scope-secret',
        'reference-secret',
        'exception-secret',
        'exception-path',
      ]) {
        expect(written).not.to.include(forbidden);
      }
      expect(written).to.include('[REDACTED]').and.to.include('[REDACTED_PATH]');
    });
  }

  it('isolates missing routes and invalid packages into partial or blocked planning results', async () => {
    const workspaceMap = join(directory, 'map.json');
    await writeFile(workspaceMap, '{"version":1,"workspaces":{"0ZuSource":"0ZuTarget"}}', 'utf8');
    const exported = cloneFixture(validExportFixture);
    exported.provenance.sourceOrgId = '00Dsource';
    exported.result!.workspaces.push({
      ...cloneFixture(exported.result!.workspaces[0]),
      source: { ...exported.result!.workspaces[0].source, sourceId: '0ZuMissing', name: 'Missing Route' },
      artifact: {
        ...exported.result!.workspaces[0].artifact,
        path: 'Missing Route',
        manifestPath: 'Missing Route/manifest.json',
      },
    });
    $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').resolves({
      envelope: cloneFixture(validInfoFixture),
      capabilities: { bulkExport: 'implemented', externalReferenceCorrelation: 'experimental', experimental: true },
    });
    $$.SANDBOX.stub(cmsPlanningServices, 'runExport').resolves(exported);
    $$.SANDBOX.stub(cmsPlanningServices, 'validatePackage').callsFake(async (_root, _envelope, workspace) => {
      if (workspace.source.sourceId === '0ZuSource') {
        return {
          sourceWorkspaceId: '0ZuSource',
          artifactPath: 'a',
          manifestPath: 'a/manifest.json',
          packageManifestSha256: workspace.artifact.manifestSha256,
          sourceOrgId: '00Dsource',
          pluginVersion: '0.4.0',
          exportSetId: exported.provenance.exportSetId!,
          correlations: exported.result!.externalReferenceCorrelations,
        };
      }
      throw new Error('unexpected validation');
    });
    const output = join(directory, 'partial.json');
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
      '--cms-plan',
      '--cms-workspace-map',
      workspaceMap,
      '--cms-export-dir',
      join(directory, 'export'),
    ]);
    expect(result.cmsPlanning).to.deep.equal({
      state: 'blocked',
      experimental: true,
      readyRoutes: 0,
      blockedRoutes: 2,
    });
    const plan = JSON.parse(await readFile(output, 'utf8')) as {
      cmsPlanning: {
        routes: Array<{ sourceWorkspaceId: string; state: string; diagnostics: Array<{ code: string }> }>;
      };
    };
    expect(plan.cmsPlanning.routes.find((route) => route.sourceWorkspaceId === '0ZuMissing')).to.deep.include({
      state: 'blocked',
    });
    expect(
      plan.cmsPlanning.routes
        .find((route) => route.sourceWorkspaceId === '0ZuMissing')!
        .diagnostics.map((item) => item.code)
    ).to.include('CMS_ROUTE_MISSING');
  });

  it('records a fully blocked result when manifest external-reference bindings fail validation', async () => {
    const workspaceMap = join(directory, 'map.json');
    const output = join(directory, 'blocked.json');
    await writeFile(workspaceMap, '{"version":1,"workspaces":{"0ZuSource":"0ZuTarget"}}', 'utf8');
    const exported = cloneFixture(validExportFixture);
    exported.provenance.sourceOrgId = '00Dsource';
    $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').resolves({
      envelope: cloneFixture(validInfoFixture),
      capabilities: { bulkExport: 'implemented', externalReferenceCorrelation: 'experimental', experimental: true },
    });
    $$.SANDBOX.stub(cmsPlanningServices, 'runExport').resolves(exported);
    $$.SANDBOX.stub(cmsPlanningServices, 'validatePackage').rejects(
      new Error('manifest external references do not exactly match correlation evidence')
    );
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
      '--cms-plan',
      '--cms-workspace-map',
      workspaceMap,
      '--cms-export-dir',
      join(directory, 'export'),
    ]);
    expect(result.cmsPlanning).to.deep.equal({
      state: 'blocked',
      experimental: true,
      readyRoutes: 0,
      blockedRoutes: 1,
    });
    const plan = JSON.parse(await readFile(output, 'utf8')) as {
      cmsPlanning: { routes: Array<{ state: string; diagnostics: Array<{ code: string; message: string }> }> };
    };
    expect(plan.cmsPlanning.routes[0]).to.deep.include({ state: 'blocked' });
    expect(plan.cmsPlanning.routes[0].diagnostics[0]).to.include({
      code: 'CMS_PACKAGE_INVALID',
      message: 'manifest external references do not exactly match correlation evidence',
    });
  });

  it('fails closed on malformed workspace maps and provider evidence', async () => {
    const badMap = join(directory, 'bad-map.json');
    await writeFile(badMap, '{"version":1,"workspaces":{"a":"b","a":"c"}}', 'utf8');
    let mapError: unknown;
    try {
      await MigrationPlanCommand.run([
        '--source-org',
        'source',
        '--target-org',
        'target',
        '--output-file',
        join(directory, 'map-plan.json'),
        '--cms-plan',
        '--cms-workspace-map',
        badMap,
        '--cms-export-dir',
        join(directory, 'export-a'),
      ]);
    } catch (error) {
      mapError = error;
    }
    expect((mapError as Error).message).to.include('duplicate JSON key');

    const goodMap = join(directory, 'good-map.json');
    await writeFile(goodMap, '{"version":1,"workspaces":{"0ZuSource":"0ZuTarget"}}', 'utf8');
    $$.SANDBOX.stub(cmsPlanningServices, 'runInfo').rejects(new Error('token=secret C:\\Users\\person\\private'));
    const failedOutput = join(directory, 'evidence-plan.json');
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      failedOutput,
      '--cms-plan',
      '--cms-workspace-map',
      goodMap,
      '--cms-export-dir',
      join(directory, 'export-b'),
    ]);
    expect(result.cmsPlanning).to.deep.equal({
      state: 'failed',
      experimental: false,
      readyRoutes: 0,
      blockedRoutes: 0,
    });
    const failedPlan = JSON.parse(await readFile(failedOutput, 'utf8')) as {
      cmsPlanning: Record<string, unknown> & { diagnostics: Array<{ message: string }> };
    };
    expect(failedPlan.cmsPlanning).not.to.have.keys('capabilities', 'exportProvenance');
    expect(failedPlan.cmsPlanning.diagnostics[0].message)
      .to.include('token=[REDACTED]')
      .and.to.include('[REDACTED_PATH]');
    expect(failedPlan.cmsPlanning.diagnostics[0].message).not.to.include('token=secret').and.not.to.include('person');
    expect(ux.log.args.flat().join(' ')).to.include('CMS planning: failed');
    expect(ux.warn.args.flat().join(' ')).to.include('Inspect cmsPlanning diagnostics');
  });

  it('rejects an existing CMS export directory before provider invocation', async () => {
    const workspaceMap = join(directory, 'map.json');
    const exportDirectory = join(directory, 'existing');
    await writeFile(workspaceMap, '{"version":1,"workspaces":{"0ZuSource":"0ZuTarget"}}', 'utf8');
    await writeFile(exportDirectory, 'occupied', 'utf8');
    const info = $$.SANDBOX.stub(cmsPlanningServices, 'runInfo');
    let caught: unknown;
    try {
      await MigrationPlanCommand.run([
        '--source-org',
        'source',
        '--target-org',
        'target',
        '--output-file',
        join(directory, 'plan.json'),
        '--cms-plan',
        '--cms-workspace-map',
        workspaceMap,
        '--cms-export-dir',
        exportDirectory,
      ]);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).to.equal('InvalidCmsExportDirectoryError');
    expect(info.called).to.equal(false);
  });

  it('rejects CMS payload or mapping fields', async () => {
    const evidence = join(directory, 'cms.json');
    await writeFile(
      evidence,
      JSON.stringify([
        {
          owner: 'cms-service',
          status: 'deferred: cms-service-contract',
          sourceReference: 'opaque-source-id',
          blockedOperation: 'listEmail.deploy',
          payload: { title: 'forbidden' },
        },
      ]),
      'utf8'
    );

    let caught: unknown;
    try {
      await MigrationPlanCommand.run([
        '--source-org',
        'source',
        '--target-org',
        'target',
        '--output-file',
        join(directory, 'migration-plan.json'),
        '--cms-evidence-file',
        evidence,
      ]);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).to.equal('InvalidCmsEvidenceError');
  });
});
