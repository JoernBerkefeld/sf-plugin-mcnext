import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection, Org } from '@salesforce/core';
import { expect } from 'chai';
import { McnClient } from '../../src/client/mcnClient.js';
import { listSegmentsStrict } from '../../src/commands/mcnext/segment/definition/create.js';
import {
  createSegmentDefinition,
  type SegmentConnectTransport,
  type SegmentDefinitionCreateSelection,
} from '../../src/segment/segmentDefinitionCreate.js';
import { type SegmentCoreRunner } from '../../src/segment/segmentDefinitionCli.js';
import { type SegmentDefinitionMappingFile } from '../../src/segment/segmentDefinition.js';

const sourceOrgId = '00D000000000000AAA';
const targetOrgId = '00D000000000001AAA';
const member = 'ui-synthetic';
const mappingFile: SegmentDefinitionMappingFile = {
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
};

async function pagedConnect(pages: unknown[]): Promise<SegmentConnectTransport> {
  let page = 0;
  const connection = {
    instanceUrl: 'https://example.my.salesforce.com',
    retrieveMaxApiVersion: async () => '67.0',
    request: async () => pages[page++],
  } as unknown as Connection;
  const org = { getConnection: () => connection } as unknown as Org;
  const client = await McnClient.create(org);
  return { list: async () => listSegmentsStrict(client), show: async () => ({}) };
}

const envelope = (operation: 'validate' | 'create' | 'retrieve') => ({
  stdout: JSON.stringify({
    status: 0,
    result: {
      id: `${operation}-job`,
      status: 'Succeeded',
      done: true,
      success: true,
      checkOnly: operation === 'validate',
      files: [
        {
          type: 'MarketSegmentDefinition',
          fullName: member,
          state: operation === 'create' ? 'Created' : 'Changed',
          filePath: `custom/main/default/marketSegmentDefinitions/${member}.marketSegmentDefinition-meta.xml`,
        },
      ],
    },
  }),
  exitCode: 0,
});

describe('bounded Segment Definition CREATE', () => {
  let root: string;
  let sourceXml: string;
  let selection: SegmentDefinitionCreateSelection;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'segment-create-test-'));
    await mkdir(join(root, 'custom/main/default/marketSegmentDefinitions'), { recursive: true });
    await writeFile(join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'custom' }] }));
    sourceXml = await readFile('test/segment/fixtures/ui-synthetic.marketSegmentDefinition-meta.xml', 'utf8');
    await writeFile(
      join(root, 'custom/main/default/marketSegmentDefinitions', `${member}.marketSegmentDefinition-meta.xml`),
      sourceXml
    );
    selection = {
      projectRoot: root,
      sourceOrg: 'source',
      targetOrg: 'target',
      expectedSourceOrgId: sourceOrgId,
      expectedTargetOrgId: targetOrgId,
      sourceFile: `custom/main/default/marketSegmentDefinitions/${member}.marketSegmentDefinition-meta.xml`,
      member,
      mappingFile,
      visibilityPolls: 2,
    };
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('stops after check-only validation for dry-run', async () => {
    const calls: string[][] = [];
    const result = await createSegmentDefinition(
      { ...selection, dryRun: true },
      {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async (args) => {
          calls.push(args);
          return envelope('validate');
        },
        connect: { list: async () => [], show: async () => ({}) },
      }
    );
    expect(result).to.include({ state: 'validated', validationJobId: 'validate-job' });
    expect(calls).to.have.length(1);
    expect(calls[0]).to.include('--dry-run');
  });

  it('fails locally on an absent mapping before Core or Connect is invoked', async () => {
    let coreCalls = 0;
    let connectCalls = 0;
    const incompleteMapping: SegmentDefinitionMappingFile = {
      schemaVersion: 1,
      segmentReferences: mappingFile.segmentReferences.filter(
        (entry) => !(entry.kind === 'field' && entry.source === 'SyntheticSourceField__c')
      ),
    };

    let error: unknown;
    try {
      await createSegmentDefinition(
        { ...selection, mappingFile: incompleteMapping },
        {
          resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
          core: async () => {
            coreCalls++;
            return envelope('validate');
          },
          connect: {
            list: async () => {
              connectCalls++;
              return [];
            },
            show: async () => {
              connectCalls++;
              return {};
            },
          },
        }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal('Missing Segment Definition mapping: field:SyntheticSourceField__c');
    expect(coreCalls).to.equal(0);
    expect(connectCalls).to.equal(0);
  });

  it('fails closed when the initial absence page omits totals', async () => {
    let validationCalls = 0;
    let applyCalls = 0;
    const connect = await pagedConnect([{ segments: [], batchSize: 200, offset: 0 }]);

    let error: unknown;
    try {
      await createSegmentDefinition(selection, {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async (args) => {
          if (args.includes('--dry-run')) validationCalls++;
          else applyCalls++;
          return envelope(args.includes('--dry-run') ? 'validate' : 'create');
        },
        connect,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('total count');
    expect(validationCalls).to.equal(0);
    expect(applyCalls).to.equal(0);
  });

  it('fails closed when the second absence pass omits totals', async () => {
    let validationCalls = 0;
    let applyCalls = 0;
    let listCalls = 0;
    const initial = await pagedConnect([{ segments: [], batchSize: 200, offset: 0, totalSize: 0 }]);
    const missingTotal = await pagedConnect([{ segments: [], batchSize: 200, offset: 0 }]);
    const connect: SegmentConnectTransport = {
      list: async () => (++listCalls === 1 ? initial.list() : missingTotal.list()),
      show: async () => ({}),
    };

    let error: unknown;
    try {
      await createSegmentDefinition(selection, {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async (args) => {
          if (args.includes('--dry-run')) validationCalls++;
          else applyCalls++;
          return envelope(args.includes('--dry-run') ? 'validate' : 'create');
        },
        connect,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('total count');
    expect(validationCalls).to.equal(1);
    expect(applyCalls).to.equal(0);
  });

  it('rejects a page-two conflict before check-only validation', async () => {
    let coreCalls = 0;
    const connect = await pagedConnect([
      { segments: [{ apiName: 'other' }], batchSize: 1, offset: 0, totalSize: 2 },
      { segments: [{ apiName: member }], batchSize: 1, offset: 1, totalSize: 2 },
    ]);

    let error: unknown;
    try {
      await createSegmentDefinition(selection, {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async () => {
          coreCalls++;
          return envelope('validate');
        },
        connect,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(coreCalls).to.equal(0);
  });

  it('rejects a page-two conflict before apply', async () => {
    let coreCalls = 0;
    let listCalls = 0;
    const initialPages = [
      { segments: [{ apiName: 'other' }], batchSize: 1, offset: 0, totalSize: 2 },
      { segments: [{ apiName: 'another' }], batchSize: 1, offset: 1, totalSize: 2 },
    ];
    const conflictPages = [
      { segments: [{ apiName: 'other' }], batchSize: 1, offset: 0, totalSize: 2 },
      { segments: [{ apiName: member }], batchSize: 1, offset: 1, totalSize: 2 },
    ];
    const first = await pagedConnect(initialPages);
    const second = await pagedConnect(conflictPages);
    const connect: SegmentConnectTransport = {
      list: async () => (++listCalls === 1 ? first.list() : second.list()),
      show: async () => ({}),
    };

    let error: unknown;
    try {
      await createSegmentDefinition(selection, {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async () => {
          coreCalls++;
          return envelope('validate');
        },
        connect,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(coreCalls).to.equal(1);
  });

  it('fails closed on malformed first-page completeness metadata before check-only', async () => {
    let coreCalls = 0;
    const connect = await pagedConnect([{ segments: [{ apiName: 'other' }], offset: 0, totalSize: 2 }]);

    let error: unknown;
    try {
      await createSegmentDefinition(selection, {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async () => {
          coreCalls++;
          return envelope('validate');
        },
        connect,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('page size');
    expect(coreCalls).to.equal(0);
  });

  it('fails closed on a malformed later-page collection envelope', async () => {
    let coreCalls = 0;
    const connect = await pagedConnect([
      { segments: [{ apiName: 'other' }], batchSize: 1, offset: 0, totalSize: 2 },
      { batchSize: 1, offset: 1, totalSize: 2 },
    ]);

    let error: unknown;
    try {
      await createSegmentDefinition(selection, {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async () => {
          coreCalls++;
          return envelope('validate');
        },
        connect,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('missing array property');
    expect(coreCalls).to.equal(0);
  });

  it('fails closed on inconsistent later-page metadata before apply', async () => {
    let validationCalls = 0;
    let applyCalls = 0;
    let listCalls = 0;
    const initial = await pagedConnect([
      { segments: [{ apiName: 'other' }], batchSize: 1, offset: 0, totalSize: 2 },
      { segments: [{ apiName: 'another' }], batchSize: 1, offset: 1, totalSize: 2 },
    ]);
    const malformed = await pagedConnect([
      { segments: [{ apiName: 'other' }], batchSize: 1, offset: 0, totalSize: 2 },
      { segments: [{ apiName: 'another' }], batchSize: 1, offset: 0, totalSize: 2 },
    ]);
    const connect: SegmentConnectTransport = {
      list: async () => (++listCalls === 1 ? initial.list() : malformed.list()),
      show: async () => ({}),
    };

    let error: unknown;
    try {
      await createSegmentDefinition(selection, {
        resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
        core: async (args) => {
          if (args.includes('--dry-run')) validationCalls++;
          else applyCalls++;
          return envelope(args.includes('--dry-run') ? 'validate' : 'create');
        },
        connect,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('inconsistent');
    expect(validationCalls).to.equal(1);
    expect(applyCalls).to.equal(0);
  });

  it('validates, rechecks guards, applies once, retrieves separately, compares criteria and correlates Connect', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    let identityCalls = 0;
    let listCalls = 0;
    const core: SegmentCoreRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      const operation = args[1] === 'retrieve' ? 'retrieve' : args.includes('--dry-run') ? 'validate' : 'create';
      if (operation === 'retrieve') {
        const project = JSON.parse(await readFile(join(cwd, 'sfdx-project.json'), 'utf8')) as {
          packageDirectories: Array<{ path: string }>;
        };
        const folder = join(cwd, project.packageDirectories[0].path, 'main/default/marketSegmentDefinitions');
        await mkdir(folder, { recursive: true });
        const transformed = sourceXml
          .replaceAll('UnifiedSyntheticSource__dlm', 'UnifiedSyntheticTarget__dlm')
          .replaceAll('UnifiedLinkSyntheticSource__dlm', 'UnifiedLinkSyntheticTarget__dlm')
          .replaceAll('SyntheticSourceDmo__dlm', 'SyntheticTargetDmo__dlm')
          .replaceAll('SyntheticSourceField__c', 'SyntheticTargetField__c')
          .replaceAll('SyntheticUnifiedId__c', 'SyntheticTargetUnifiedId__c')
          .replaceAll('SyntheticUnifiedRecordId__c', 'SyntheticTargetUnifiedRecordId__c')
          .replaceAll('SyntheticSourceRecordId__c', 'SyntheticTargetSourceRecordId__c')
          .replaceAll('SyntheticSourceId__c', 'SyntheticTargetSourceId__c');
        await writeFile(join(folder, `${member}.marketSegmentDefinition-meta.xml`), transformed);
      }
      return envelope(operation);
    };
    const descriptor = {
      apiName: member,
      marketSegmentDefinitionId: '3HX000000000000AAA',
      marketSegmentId: '1sg000000000000AAA',
      segmentType: 'UI',
      publishStatus: 'DRAFT',
      segmentStatus: 'DRAFT',
    };
    const connect: SegmentConnectTransport = {
      list: async () => {
        listCalls++;
        return listCalls < 3 ? [] : [descriptor];
      },
      show: async () => ({ segments: [descriptor] }),
    };
    const result = await createSegmentDefinition(selection, {
      resolveOrgIdentity: async (alias) => {
        identityCalls++;
        return alias === 'source' ? sourceOrgId : targetOrgId;
      },
      core,
      connect,
    });
    expect(result).to.include({ state: 'succeeded', applyJobId: 'create-job' });
    expect(identityCalls).to.equal(4);
    expect(calls.filter((call) => call.args[1] === 'deploy' && !call.args.includes('--dry-run'))).to.have.length(1);
    expect(calls.find((call) => call.args[1] === 'retrieve')?.cwd).not.to.equal(calls[0].cwd);
  });

  it('returns pending after bounded visibility lag without redeploying', async () => {
    let applies = 0;
    const result = await createSegmentDefinition(selection, {
      resolveOrgIdentity: async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId),
      core: async (args, cwd) => {
        const operation = args[1] === 'retrieve' ? 'retrieve' : args.includes('--dry-run') ? 'validate' : 'create';
        if (operation === 'create') applies++;
        if (operation === 'retrieve') {
          const folder = join(cwd, 'custom/main/default/marketSegmentDefinitions');
          await mkdir(folder, { recursive: true });
          const mapped = sourceXml
            .replaceAll('UnifiedSyntheticSource__dlm', 'UnifiedSyntheticTarget__dlm')
            .replaceAll('UnifiedLinkSyntheticSource__dlm', 'UnifiedLinkSyntheticTarget__dlm')
            .replaceAll('SyntheticSourceDmo__dlm', 'SyntheticTargetDmo__dlm')
            .replaceAll('SyntheticSourceField__c', 'SyntheticTargetField__c')
            .replaceAll('SyntheticUnifiedId__c', 'SyntheticTargetUnifiedId__c')
            .replaceAll('SyntheticUnifiedRecordId__c', 'SyntheticTargetUnifiedRecordId__c')
            .replaceAll('SyntheticSourceRecordId__c', 'SyntheticTargetSourceRecordId__c')
            .replaceAll('SyntheticSourceId__c', 'SyntheticTargetSourceId__c');
          await writeFile(join(folder, `${member}.marketSegmentDefinition-meta.xml`), mapped);
        }
        return envelope(operation);
      },
      connect: { list: async () => [], show: async () => ({}) },
    });
    expect(result.state).to.equal('pending');
    expect(applies).to.equal(1);
  });

  it('rejects guard, conflict, malformed Connect, lifecycle and readback failures without write retry', async () => {
    const scenarios = [
      { name: 'same org', resolver: async () => sourceOrgId },
      {
        name: 'conflict',
        connect: { list: async () => [{ apiName: member }], show: async () => ({}) },
      },
      {
        name: 'malformed Connect',
        connect: {
          list: async () => [],
          show: async () => ({ segment: [] }),
        },
      },
    ];
    for (const scenario of scenarios) {
      let applies = 0;
      let lists = 0;
      const connect = scenario.connect ?? {
        list: async () => {
          lists++;
          return lists < 3
            ? []
            : [
                {
                  apiName: member,
                  marketSegmentDefinitionId: '3HX000000000000AAA',
                  marketSegmentId: '1sg000000000000AAA',
                  segmentType: 'UI',
                  publishStatus: 'DRAFT',
                  segmentStatus: 'DRAFT',
                },
              ];
        },
        show: async () => ({ segment: [] }),
      };
      let error: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- each safety scenario owns isolated mutable counters
        await createSegmentDefinition(selection, {
          resolveOrgIdentity: scenario.resolver ?? (async (alias) => (alias === 'source' ? sourceOrgId : targetOrgId)),
          core: async (args, cwd) => {
            const operation = args[1] === 'retrieve' ? 'retrieve' : args.includes('--dry-run') ? 'validate' : 'create';
            if (operation === 'create') applies++;
            if (operation === 'retrieve') {
              const folder = join(cwd, 'custom/main/default/marketSegmentDefinitions');
              await mkdir(folder, { recursive: true });
              await writeFile(join(folder, `${member}.marketSegmentDefinition-meta.xml`), sourceXml);
            }
            return envelope(operation);
          },
          connect,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error, scenario.name).to.be.instanceOf(Error);
      expect(applies, scenario.name).to.be.at.most(1);
    }
  });
});
