import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { Org } from '@salesforce/core';
import { buildMigrationPlan, runMigrationPreflight, writeMigrationPlan } from '../../src/migration/migrationPlan.js';

function org(
  orgId: string,
  maximum: string,
  probeError?: Error,
  requestedVersions: Array<string | undefined> = [],
  maximumError?: Error
): Org {
  return {
    getOrgId: () => orgId,
    getConnection: (version?: string) => {
      requestedVersions.push(version);
      return {
        retrieveMaxApiVersion: async () => {
          if (maximumError) throw maximumError;
          return maximum;
        },
        request: async (path: string) => {
          expect(path).to.equal('/limits');
          if (probeError) throw probeError;
          return {};
        },
      };
    },
  } as unknown as Org;
}

describe('migration plan', () => {
  it('runs separate bounded authenticated API v67 checks against source and target', async () => {
    const sourceVersions: Array<string | undefined> = [];
    const targetVersions: Array<string | undefined> = [];
    const result = await runMigrationPreflight(
      org('00Dsource', '67.0', undefined, sourceVersions),
      org('00Dtarget', '68.0', undefined, targetVersions)
    );
    expect(result).to.deep.include({ key: 'distinct-orgs', status: 'pass', message: 'Source and target are distinct orgs.' });
    expect(result.find((check) => check.key === 'source-api-v67')?.status).to.equal('pass');
    expect(result.find((check) => check.key === 'target-api-v67')?.status).to.equal('pass');
    expect(result.find((check) => check.key === 'target-environment')?.status).to.equal('manual');
    expect(sourceVersions).to.deep.equal([undefined, '67.0']);
    expect(targetVersions).to.deep.equal([undefined, '67.0']);
  });

  it('does not let the advertised maximum pass a failed v67 request', async () => {
    const result = await runMigrationPreflight(
      org('00Dsame', '68.0', new Error('source denied')),
      org('00Dsame', '69.0')
    );
    expect(result.filter((check) => check.status === 'blocked').map((check) => check.key)).to.deep.equal([
      'distinct-orgs',
      'source-api-v67',
    ]);
    expect(result.find((check) => check.key === 'source-api-v67')?.message).to.contain('advertised maximum v68.0');
    expect(result.find((check) => check.key === 'source-api-v67')?.message).to.contain('source denied');
  });

  it('treats maximum discovery as optional and completes both pinned checks independently', async () => {
    const sourceVersions: Array<string | undefined> = [];
    const targetVersions: Array<string | undefined> = [];
    const result = await runMigrationPreflight(
      org('00Dsource', 'ignored', undefined, sourceVersions, new Error('source maximum denied')),
      org('00Dtarget', 'ignored', new Error('target v67 denied'), targetVersions, new Error('target maximum denied'))
    );

    expect(result.find((check) => check.key === 'source-api-v67')).to.include({ status: 'pass' });
    expect(result.find((check) => check.key === 'source-api-v67')?.message).to.contain(
      'advertised maximum unavailable: source maximum denied'
    );
    expect(result.find((check) => check.key === 'target-api-v67')).to.include({ status: 'blocked' });
    expect(result.find((check) => check.key === 'target-api-v67')?.message).to.contain('target v67 denied');
    expect(sourceVersions).to.deep.equal([undefined, '67.0']);
    expect(targetVersions).to.deep.equal([undefined, '67.0']);
  });

  it('builds a sorted full inventory with no executable target payloads', () => {
    const plan = buildMigrationPlan({
      sourceOrgId: '00Dsource',
      targetOrgId: '00Dtarget',
      preflight: [{ key: 'z-check', status: 'pass', message: 'ok' }],
    });
    expect(plan.mode).to.equal('read-only');
    expect(plan.executableTargetPayloads).to.deep.equal([]);
    const expectedKeys = [
      'accountConfiguration',
      'authenticatedSendingDomains',
      'briefConfiguration',
      'briefRecords',
      'businessUnitReferences',
      'calculatedInsights',
      'campaignConfiguration',
      'campaignRecords',
      'cmsArtifacts',
      'communicationSubscriptions',
      'connectors',
      'consentHistoryRows',
      'consentPolicies',
      'contactConfiguration',
      'corsOrigins',
      'credentials',
      'crmAudienceRows',
      'cspTrustedSites',
      'customerRows',
      'customObjectChildMetadata',
      'customObjectConfiguration',
      'dashboardFolders',
      'dashboards',
      'data360DataGraphs',
      'data360DataKits',
      'data360DataStreams',
      'dataSpaces',
      'dependentPicklists',
      'dloDmoMappings',
      'dloSchemaDefinitions',
      'dmoRows',
      'dmoSchemaDefinitions',
      'dnsVerification',
      'engagementChannelTypes',
      'fieldReferenceClosure',
      'flexiPages',
      'flows',
      'globalValueSets',
      'identityResolution',
      'landingPageExternalFormFraming',
      'landingPageSites',
      'layouts',
      'leadConfiguration',
      'listEmailConfiguration',
      'listEmailRecords',
      'localValueSets',
      'managedContentSchema',
      'managedPackages',
      'marketSegmentDefinition',
      'marketSegmentObjectFieldConfiguration',
      'marketSegmentRecords',
      'operationalRows',
      'physicalAddresses',
      'productLicenses',
      'prospectIdentity',
      'recordTypes',
      'remoteSiteSettings',
      'reportFolders',
      'reports',
      'segmentMembers',
      'senderAddresses',
      'siteReferences',
      'subscriptionChannelTypes',
      'targetComponents',
      'targetPermissions',
      'userAssignments',
    ];
    expect(plan.inventory.map((item) => item.key)).to.deep.equal(expectedKeys);
    expect(plan.inventory.find((item) => item.key === 'cmsArtifacts')).to.include({ owner: 'cms-service', status: 'deferred' });
    for (const key of [
      'authenticatedSendingDomains',
      'connectors',
      'credentials',
      'dataSpaces',
      'dnsVerification',
      'landingPageExternalFormFraming',
      'landingPageSites',
      'managedPackages',
      'physicalAddresses',
      'productLicenses',
      'senderAddresses',
      'targetComponents',
      'targetPermissions',
      'userAssignments',
    ]) {
      expect(plan.inventory.find((item) => item.key === key), key).to.include({
        owner: 'external/manual',
        status: 'manual prerequisite',
      });
    }
    for (const key of ['consentHistoryRows', 'crmAudienceRows', 'customerRows', 'dmoRows', 'operationalRows']) {
      expect(plan.inventory.find((item) => item.key === key), key).to.include({
        owner: 'secondary-data',
        status: 'deferred',
        classification: 'secondary-data',
      });
    }
    expect(plan.inventory.find((item) => item.key === 'segmentMembers')).to.include({
      owner: 'secondary-data',
      status: 'unsupported',
      classification: 'secondary-data',
    });
    expect(plan.inventory.find((item) => item.key === 'prospectIdentity')).to.include({
      owner: 'external/manual',
      status: 'unsupported',
      classification: 'configuration',
    });
    expect(plan.inventory.filter((item) => item.status === 'delegated')).to.deep.equal([]);
  });

  it('preserves only the minimal opaque CMS dependency shape and sorts it deterministically', () => {
    const plan = buildMigrationPlan({
      sourceOrgId: '00Dsource',
      targetOrgId: '00Dtarget',
      preflight: [],
      deferredCmsDependencies: [
        { owner: 'cms-service', status: 'deferred: cms-service-contract', sourceReference: 'z', blockedOperation: 'listEmail.deploy' },
        { owner: 'cms-service', status: 'deferred: cms-service-contract', sourceReference: 'a', blockedOperation: 'campaign.deploy' },
      ],
    });
    expect(plan.deferredCmsDependencies[0]).to.deep.equal({
      owner: 'cms-service',
      status: 'deferred: cms-service-contract',
      sourceReference: 'a',
      blockedOperation: 'campaign.deploy',
    });
    expect(Object.keys(plan.deferredCmsDependencies[0] ?? {}).sort()).to.deep.equal([
      'blockedOperation',
      'owner',
      'sourceReference',
      'status',
    ]);
  });

  it('writes byte-stable JSON for identical inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcnext-plan-'));
    try {
      const plan = buildMigrationPlan({ sourceOrgId: '00Dsource', targetOrgId: '00Dtarget', preflight: [] });
      const first = join(directory, 'first.json');
      const second = join(directory, 'nested', 'second.json');
      await writeMigrationPlan(plan, first);
      await writeMigrationPlan(plan, second);
      expect(await readFile(first, 'utf8')).to.equal(await readFile(second, 'utf8'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
