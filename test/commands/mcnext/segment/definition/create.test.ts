import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Org } from '@salesforce/core';
import { expect } from 'chai';
import SegmentDefinitionCreate, {
  segmentDefinitionCreateServices,
} from '../../../../../src/commands/mcnext/segment/definition/create.js';

const sourceOrgId = '00D000000000000AAA';
const targetOrgId = '00D000000000001AAA';
const member = 'ui-synthetic';

const validationEnvelope = {
  stdout: JSON.stringify({
    status: 0,
    result: {
      id: 'validate-job',
      status: 'Succeeded',
      done: true,
      success: true,
      checkOnly: true,
      files: [
        {
          type: 'MarketSegmentDefinition',
          fullName: member,
          state: 'Changed',
          filePath: `custom/main/default/marketSegmentDefinitions/${member}.marketSegmentDefinition-meta.xml`,
        },
      ],
    },
  }),
  exitCode: 0,
};

describe('mcnext segment definition create command', () => {
  const originalCreateOrg = segmentDefinitionCreateServices.createOrg;
  const originalCreateConnect = segmentDefinitionCreateServices.createConnect;
  const originalCore = segmentDefinitionCreateServices.core;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcnext-segment-create-command-'));
  });

  afterEach(async () => {
    segmentDefinitionCreateServices.createOrg = originalCreateOrg;
    segmentDefinitionCreateServices.createConnect = originalCreateConnect;
    segmentDefinitionCreateServices.core = originalCore;
    await rm(directory, { recursive: true, force: true });
  });

  it('requires explicit aliases, identities, project source, member and mapping', () => {
    for (const flag of [
      'source-org',
      'target-org',
      'expected-source-org-id',
      'expected-target-org-id',
      'project-dir',
      'source-file',
      'member',
      'mapping-file',
    ] as const)
      expect(SegmentDefinitionCreate.flags[flag].required).to.equal(true);
    expect(SegmentDefinitionCreate.description).to.include('No publication');
    expect(SegmentDefinitionCreate.description).to.include('never redeploys');
  });

  for (const scenario of [
    {
      name: 'malformed expected identity',
      expectedSourceOrgId: 'bad-id',
      expectedTargetOrgId: targetOrgId,
      resolver: async (): Promise<string> => sourceOrgId,
      message: 'valid 18-character Salesforce org ID',
    },
    {
      name: 'mismatched resolved identity',
      expectedSourceOrgId: sourceOrgId,
      expectedTargetOrgId: targetOrgId,
      resolver: async (alias: string): Promise<string> => (alias === 'source' ? targetOrgId : targetOrgId),
      message: 'does not match the expected org ID',
    },
    {
      name: 'equal resolved identities',
      expectedSourceOrgId: sourceOrgId,
      expectedTargetOrgId: sourceOrgId,
      resolver: async (): Promise<string> => sourceOrgId,
      message: 'must be distinct',
    },
  ]) {
    it(`blocks ${scenario.name} before target discovery or transports`, async () => {
      let targetOrgDiscoveryCalls = 0;
      let createConnectCalls = 0;
      let coreCalls = 0;
      segmentDefinitionCreateServices.createOrg = async (alias) => {
        if (alias === 'target') targetOrgDiscoveryCalls++;
        return { getOrgId: async () => scenario.resolver(alias) } as unknown as Org;
      };
      segmentDefinitionCreateServices.createConnect = async () => {
        createConnectCalls++;
        return { list: async () => [], show: async () => ({}) };
      };
      segmentDefinitionCreateServices.core = async () => {
        coreCalls++;
        return validationEnvelope;
      };

      const command = commandWithFlags({
        expectedSourceOrgId: scenario.expectedSourceOrgId,
        expectedTargetOrgId: scenario.expectedTargetOrgId,
      });
      let error: unknown;
      try {
        await command.run();
      } catch (caught) {
        error = caught;
      }

      expect(String(error)).to.include(scenario.message);
      expect(targetOrgDiscoveryCalls).to.equal(0);
      expect(createConnectCalls).to.equal(0);
      expect(coreCalls).to.equal(0);
    });
  }

  it('uses the verified target org for Connect and proceeds for distinct identities', async () => {
    await mkdir(join(directory, 'custom/main/default/marketSegmentDefinitions'), { recursive: true });
    await writeFile(join(directory, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'custom' }] }));
    const sourceXml = await readFile('test/segment/fixtures/ui-synthetic.marketSegmentDefinition-meta.xml', 'utf8');
    await writeFile(
      join(directory, 'custom/main/default/marketSegmentDefinitions', `${member}.marketSegmentDefinition-meta.xml`),
      sourceXml
    );
    await writeFile(
      join(directory, 'mapping.json'),
      JSON.stringify({
        schemaVersion: 1,
        segmentReferences: [
          { kind: 'unifiedDmo', source: 'UnifiedSyntheticSource__dlm', target: 'UnifiedSyntheticTarget__dlm' },
          { kind: 'linkDmo', source: 'UnifiedLinkSyntheticSource__dlm', target: 'UnifiedLinkSyntheticTarget__dlm' },
          { kind: 'dmo', source: 'SyntheticSourceDmo__dlm', target: 'SyntheticTargetDmo__dlm' },
          { kind: 'field', source: 'SyntheticSourceField__c', target: 'SyntheticTargetField__c' },
          { kind: 'field', source: 'SyntheticUnifiedId__c', target: 'SyntheticTargetUnifiedId__c' },
          { kind: 'field', source: 'SyntheticUnifiedRecordId__c', target: 'SyntheticTargetUnifiedRecordId__c' },
          { kind: 'field', source: 'SyntheticSourceRecordId__c', target: 'SyntheticTargetSourceRecordId__c' },
          { kind: 'field', source: 'SyntheticSourceId__c', target: 'SyntheticTargetSourceId__c' },
          {
            kind: 'relationship',
            source:
              'UnifiedSyntheticSource__dlm.SyntheticUnifiedId__c->UnifiedLinkSyntheticSource__dlm.SyntheticUnifiedRecordId__c',
            target:
              'UnifiedSyntheticTarget__dlm.SyntheticTargetUnifiedId__c->UnifiedLinkSyntheticTarget__dlm.SyntheticTargetUnifiedRecordId__c',
          },
          {
            kind: 'relationship',
            source:
              'UnifiedLinkSyntheticSource__dlm.SyntheticSourceRecordId__c->SyntheticSourceDmo__dlm.SyntheticSourceId__c',
            target:
              'UnifiedLinkSyntheticTarget__dlm.SyntheticTargetSourceRecordId__c->SyntheticTargetDmo__dlm.SyntheticTargetSourceId__c',
          },
        ],
      })
    );

    const targetOrg = { getOrgId: () => targetOrgId } as Org;
    const calls: string[] = [];
    segmentDefinitionCreateServices.createOrg = async (alias) => {
      calls.push(`resolve:${alias}`);
      return alias === 'source' ? ({ getOrgId: () => sourceOrgId } as Org) : targetOrg;
    };
    segmentDefinitionCreateServices.createConnect = async (org) => {
      expect(org).to.equal(targetOrg);
      calls.push('connect');
      return { list: async () => [], show: async () => ({}) };
    };
    segmentDefinitionCreateServices.core = async () => {
      calls.push('core');
      return validationEnvelope;
    };

    const result = await commandWithFlags({ expectedSourceOrgId: sourceOrgId, expectedTargetOrgId: targetOrgId }).run();

    expect(result.state).to.equal('validated');
    expect(calls).to.deep.equal(['resolve:source', 'resolve:target', 'connect', 'core']);
  });

  function commandWithFlags(identity: {
    expectedSourceOrgId: string;
    expectedTargetOrgId: string;
  }): SegmentDefinitionCreate {
    const command = Object.create(SegmentDefinitionCreate.prototype) as SegmentDefinitionCreate;
    Object.assign(command, {
      log: () => {},
      parse: async () => ({
        flags: {
          'source-org': 'source',
          'target-org': 'target',
          'expected-source-org-id': identity.expectedSourceOrgId,
          'expected-target-org-id': identity.expectedTargetOrgId,
          'project-dir': directory,
          'source-file': `custom/main/default/marketSegmentDefinitions/${member}.marketSegmentDefinition-meta.xml`,
          member,
          'mapping-file': 'mapping.json',
          'dry-run': true,
          wait: 10,
          'visibility-polls': 3,
        },
      }),
    });
    return command;
  }
});
