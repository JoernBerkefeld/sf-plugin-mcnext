import { expect } from 'chai';
import {
  associateFlow,
  FlowAssociationError,
  type FlowAssociationInput,
  type FlowAssociationTransport,
} from '../../src/core/flowAssociation.js';

const id = (prefix: string, index = 1): string => `${prefix}${String(index).padStart(12, '0')}AAA`;
const rows = (records: unknown[]): unknown => ({ done: true, totalSize: records.length, records });
const input = (): FlowAssociationInput => ({
  operation: 'apply',
  targetOrg: 'explicit-target',
  expectedOrgId: id('00D', 2),
  apiVersion: '67.0',
  source: { orgId: id('00D'), campaignId: id('701'), flowRecordId: id('2aF'), member: 'Source', segmentId: id('1sg') },
  target: {
    campaignId: id('701', 2),
    flowRecordId: id('2aF', 2),
    member: 'Target',
    segmentId: id('1sg', 2),
    segmentApiName: 'ExplicitSegment',
    segmentDefinitionId: id('3HX', 2),
    expectedDefinitionId: id('300', 2),
    expectedLatestVersionId: id('301', 2),
  },
  artifact: {
    schemaVersion: 1,
    kind: 'campaign-flow-associations',
    source: { orgId: id('00D'), apiVersion: '67.0', campaignId: id('701') },
    flows: [
      {
        member: 'Source',
        flowRecordId: id('2aF'),
        associatedRecordId: id('701'),
        segmentId: id('1sg'),
        definitionId: id('300'),
        latestVersionId: id('301'),
        nativeFile: 'flows/Source.flow-meta.xml',
        nativeSha256: 'a'.repeat(64),
      },
    ],
  },
});
type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const selection = input();
  const target = selection.target;
  const metadata = {
    status: 'InvalidDraft',
    processType: 'AutoLaunchedFlow',
    dataSpace: 'default',
    start: { triggerType: 'Segment', object: 'UnifiedssotIndividualMkt__dlm', segment: target.segmentId },
  };
  const record: Record<string, unknown> = {
    Id: target.flowRecordId,
    ApiName: target.member,
    SegmentId: target.segmentId,
    AssociatedRecordId: null,
    ProgressStatus: 'Draft',
    ActiveVersionId: null,
    SystemModstamp: 'before',
  };
  const campaign: Record<string, unknown> = { Id: target.campaignId, IsActive: false };
  const definition = {
    Id: target.expectedDefinitionId,
    DeveloperName: target.member,
    ActiveVersionId: null,
    LatestVersionId: target.expectedLatestVersionId,
  };
  const version = {
    Id: target.expectedLatestVersionId,
    DefinitionId: target.expectedDefinitionId,
    Metadata: structuredClone(metadata),
  };
  const native = { fullName: target.member, ...structuredClone(metadata) };
  const segment = {
    Id: target.segmentId,
    IsDeleted: false,
    MarketSegmentType: 'DBT',
    SegmentStatus: 'ACTIVE',
    PublishStatus: null,
    PublishScheduleInterval: 'NO_REFRESH',
    DataSpaceId: id('0vh'),
    LastSegmentMemberCount: 145,
  };
  const dataSpace = { Id: id('0vh'), DataSpaceApiName: 'default', Status: 'ACTIVE', IsDeleted: false };
  const connect: Record<string, unknown> = {
    apiName: target.segmentApiName,
    marketSegmentId: target.segmentId,
    marketSegmentDefinitionId: target.segmentDefinitionId,
    segmentType: 'DBT',
    segmentStatus: 'ACTIVE',
    publishInterval: 'NO_REFRESH',
    dataSpace: 'default',
    segmentOnApiName: metadata.start.object,
    segmentOnId: id('0gj'),
  };
  const detail = structuredClone(connect);
  const schema: {
    name: string;
    updateable?: boolean;
    fields: Array<{ name: string; updateable: boolean; referenceTo: string[] }>;
  } = {
    name: 'FlowRecord',
    updateable: true,
    fields: [{ name: 'AssociatedRecordId', updateable: true, referenceTo: ['Campaign'] }],
  };
  const writes: Array<{ path: string; update: unknown }> = [];
  const calls: string[] = [];
  let identityReads = 0;
  const options = {
    orgId: selection.expectedOrgId,
    pending: false,
    ambiguous: false,
    commit: true,
    childMissing: false,
    onIdentity: undefined as ((read: number) => void) | undefined,
    pages: undefined as Array<Record<string, unknown>> | undefined,
    details: undefined as unknown,
    queryOverride: undefined as ((soql: string) => unknown) | undefined,
  };
  const channel: FlowAssociationTransport = {
    resolveOrgId: async () => {
      identityReads++;
      options.onIdentity?.(identityReads);
      calls.push('identity');
      return options.orgId;
    },
    readFlow: async () => {
      calls.push('metadata');
      return structuredClone(native);
    },
    query: async (soql, tooling) => {
      calls.push(`${tooling ? 'tooling:' : ''}${soql}`);
      const overridden = options.queryOverride?.(soql);
      if (overridden !== undefined) return overridden;
      if (soql.includes('FROM Organization')) return rows([{ Id: options.orgId }]);
      if (soql.includes('FROM DeployRequest'))
        return rows(options.pending ? [{ Id: id('0Af'), Status: 'InProgress' }] : []);
      if (soql.includes('FROM FlowDefinition')) return rows([structuredClone(definition)]);
      if (soql.includes('FROM DataSpace')) return rows([structuredClone(dataSpace)]);
      if (soql.includes('FROM Campaign'))
        return rows([
          {
            ...campaign,
            Flows: rows(
              record.AssociatedRecordId === target.campaignId && !options.childMissing ? [structuredClone(record)] : []
            ),
          },
        ]);
      throw new Error('Unexpected query');
    },
    request: async (path, update) => {
      calls.push(path);
      if (update) {
        writes.push({ path, update });
        if (options.commit) {
          record.AssociatedRecordId = update.body.AssociatedRecordId;
          record.SystemModstamp = 'after';
        }
        if (options.ambiguous) throw new Error('transport lost after possible commit');
        return undefined;
      }
      if (path.endsWith('/describe')) return structuredClone(schema);
      if (path.includes('/sobjects/FlowRecord/')) return structuredClone(record);
      if (path.includes('/tooling/sobjects/Flow/')) return structuredClone(version);
      if (path.includes('/sobjects/MarketSegment/')) return structuredClone(segment);
      if (path.includes('/ssot/segments?'))
        return options.pages?.shift() ?? { offset: 0, totalSize: 1, segments: [structuredClone(connect)] };
      if (path.includes('/ssot/segments/')) return options.details ?? { segments: [structuredClone(detail)] };
      throw new Error('Unexpected request');
    },
  };
  return {
    selection,
    channel,
    options,
    record,
    campaign,
    definition,
    version,
    native,
    segment,
    dataSpace,
    connect,
    detail,
    schema,
    writes,
    calls,
  };
}
async function rejects(f: Fixture, code: string, attempted = false): Promise<void> {
  try {
    await associateFlow(f.selection, f.channel);
    expect.fail('Expected guard rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(FlowAssociationError);
    expect((error as FlowAssociationError).code).to.equal(code);
    expect((error as FlowAssociationError).writeAttempted).to.equal(attempted);
  }
  expect(f.writes).to.have.length(attempted ? 1 : 0);
}

describe('Bounded inactive Flow attachment', () => {
  it('performs one sole-field PATCH after two complete qualifications and independent readback', async () => {
    const f = fixture();
    const result = await associateFlow(f.selection, f.channel);
    expect(result.state).to.equal('attached');
    expect(result.writeOutcome).to.equal('acknowledged');
    expect(f.writes).to.deep.equal([
      {
        path: `/services/data/v67.0/sobjects/FlowRecord/${f.selection.target.flowRecordId}`,
        update: { method: 'PATCH', body: { AssociatedRecordId: f.selection.target.campaignId } },
      },
    ]);
    expect(f.calls.filter((call) => call === 'identity')).to.have.length(3);
    expect(f.calls.filter((call) => call === 'metadata')).to.have.length(3);
    expect(f.calls.filter((call) => call.includes('FROM Campaign'))).to.have.length(3);
    expect(f.segment.LastSegmentMemberCount).to.equal(145);
  });
  it('plans without writing or claiming attachment', async () => {
    const f = fixture();
    f.selection.operation = 'plan';
    expect((await associateFlow(f.selection, f.channel)).state).to.equal('planned');
    expect(f.writes).to.have.length(0);
  });
  it('verifies an already-associated noop without resetting it', async () => {
    const f = fixture();
    f.record.AssociatedRecordId = f.selection.target.campaignId;
    expect((await associateFlow(f.selection, f.channel)).state).to.equal('noop');
    expect(f.writes).to.have.length(0);
  });
  it('refuses another Campaign without overwrite', async () => {
    const f = fixture();
    f.record.AssociatedRecordId = id('701', 3);
    await rejects(f, 'CONFLICT');
  });
  it('reconciles a lost successful PATCH response without retry', async () => {
    const f = fixture();
    f.options.ambiguous = true;
    expect((await associateFlow(f.selection, f.channel)).writeOutcome).to.equal('ambiguous-reconciled');
    expect(f.writes).to.have.length(1);
  });
  it('retains an ambiguous uncommitted outcome for reconciliation without retry', async () => {
    const f = fixture();
    f.options.ambiguous = true;
    f.options.commit = false;
    await rejects(f, 'RECONCILIATION_REQUIRED', true);
  });
  it('does not trust acknowledged writes without independent Campaign child evidence', async () => {
    const f = fixture();
    f.options.childMissing = true;
    await rejects(f, 'RECONCILIATION_REQUIRED', true);
  });
  it('rejects a noop missing independent child evidence', async () => {
    const f = fixture();
    f.record.AssociatedRecordId = f.selection.target.campaignId;
    f.options.childMissing = true;
    await rejects(f, 'BLOCKED');
  });
  const blocked: Array<[string, (f: Fixture) => void]> = [
    [
      'wrong org',
      (f) => {
        const mutable = f;
        mutable.options.orgId = id('00D', 3);
      },
    ],
    [
      'pending deployment',
      (f) => {
        const mutable = f;
        mutable.options.pending = true;
      },
    ],
    [
      'nonwritable object schema',
      (f) => {
        const mutable = f;
        mutable.schema.updateable = false;
      },
    ],
    [
      'missing object updateability',
      (f) => {
        const mutable = f;
        delete mutable.schema.updateable;
      },
    ],
    [
      'nonwritable schema',
      (f) => {
        const mutable = f;
        mutable.schema.fields[0].updateable = false;
      },
    ],
    [
      'wrong relationship',
      (f) => {
        const mutable = f;
        mutable.schema.fields[0].referenceTo = ['Account'];
      },
    ],
    [
      'active Campaign',
      (f) => {
        const mutable = f;
        mutable.campaign.IsActive = true;
      },
    ],
    [
      'active record',
      (f) => {
        const mutable = f;
        mutable.record.ActiveVersionId = id('301');
      },
    ],
    [
      'non-Draft record',
      (f) => {
        const mutable = f;
        mutable.record.ProgressStatus = 'InProgress';
      },
    ],
    [
      'wrong record',
      (f) => {
        const mutable = f;
        mutable.record.Id = id('2aF', 3);
      },
    ],
    [
      'wrong selected Segment',
      (f) => {
        const mutable = f;
        mutable.record.SegmentId = id('1sg', 3);
      },
    ],
    [
      'replaced latest',
      (f) => {
        const mutable = f;
        mutable.definition.LatestVersionId = id('301', 3);
      },
    ],
    [
      'active definition',
      (f) => {
        const mutable = f;
        Object.assign(mutable.definition, { ActiveVersionId: id('301') });
      },
    ],
    [
      'wrong Tooling definition',
      (f) => {
        const mutable = f;
        mutable.version.DefinitionId = id('300', 3);
      },
    ],
    [
      'native fullName',
      (f) => {
        const mutable = f;
        mutable.native.fullName = 'Different';
      },
    ],
    [
      'native status',
      (f) => {
        const mutable = f;
        mutable.native.status = 'Active';
      },
    ],
    [
      'Tooling start object',
      (f) => {
        const mutable = f;
        mutable.version.Metadata.start.object = 'Different__dlm';
      },
    ],
    [
      'native start Segment',
      (f) => {
        const mutable = f;
        mutable.native.start.segment = id('1sg', 3);
      },
    ],
    [
      'native dataspace',
      (f) => {
        const mutable = f;
        mutable.native.dataSpace = 'other';
      },
    ],
    [
      'unsupported type',
      (f) => {
        const mutable = f;
        mutable.segment.MarketSegmentType = 'UI';
      },
    ],
    [
      'unsupported status',
      (f) => {
        const mutable = f;
        mutable.segment.SegmentStatus = 'INACTIVE';
      },
    ],
    [
      'published segment',
      (f) => {
        Object.assign(f.segment, { PublishStatus: 'SUCCESS' });
      },
    ],
    [
      'refresh schedule',
      (f) => {
        const mutable = f;
        mutable.segment.PublishScheduleInterval = 'DAILY';
      },
    ],
    [
      'deleted segment',
      (f) => {
        const mutable = f;
        mutable.segment.IsDeleted = true;
      },
    ],
    [
      'inactive DataSpace',
      (f) => {
        const mutable = f;
        mutable.dataSpace.Status = 'INACTIVE';
      },
    ],
    [
      'DataSpace API identity',
      (f) => {
        const mutable = f;
        mutable.dataSpace.DataSpaceApiName = 'other';
      },
    ],
    [
      'deleted DataSpace',
      (f) => {
        const mutable = f;
        mutable.dataSpace.IsDeleted = true;
      },
    ],
    [
      'Connect object',
      (f) => {
        const mutable = f;
        mutable.detail.segmentOnApiName = 'Other__dlm';
      },
    ],
    [
      'Connect definition',
      (f) => {
        const mutable = f;
        mutable.detail.marketSegmentDefinitionId = id('3HX', 3);
      },
    ],
    [
      'Connect publish status',
      (f) => {
        const mutable = f;
        mutable.detail.publishStatus = 'SUCCESS';
      },
    ],
    [
      'Connect object identity',
      (f) => {
        const mutable = f;
        mutable.detail.segmentOnId = id('0gj', 3);
      },
    ],
  ];
  for (const [name, mutate] of blocked) {
    it(`blocks ${name} before any write`, async () => {
      const f = fixture();
      mutate(f);
      await rejects(f, 'BLOCKED');
    });
  }
  it('detects an immediate-prewrite association race', async () => {
    const f = fixture();
    f.options.onIdentity = (read) => {
      if (read === 2) f.record.AssociatedRecordId = id('701', 3);
    };
    await rejects(f, 'CONFLICT');
  });
  it('detects a prewrite SystemModstamp change', async () => {
    const f = fixture();
    f.options.onIdentity = (read) => {
      if (read === 2) f.record.SystemModstamp = 'concurrent';
    };
    await rejects(f, 'CONFLICT');
  });
  it('fails reconciliation when latest identity changes after write', async () => {
    const f = fixture();
    f.options.onIdentity = (read) => {
      if (read === 3) f.definition.LatestVersionId = id('301', 3);
    };
    await rejects(f, 'RECONCILIATION_REQUIRED', true);
  });
  it('requires explicit matching source correspondence, never infers from names or audience counts', async () => {
    const f = fixture();
    f.selection.source.segmentId = id('1sg', 3);
    await rejects(f, 'INVALID_INPUT');
  });
  it('rejects ambiguous artifact selection', async () => {
    const f = fixture();
    f.selection.artifact.flows.push(structuredClone(f.selection.artifact.flows[0]));
    await rejects(f, 'INVALID_INPUT');
  });
  it('rejects wrong API version before transport', async () => {
    const f = fixture();
    Object.assign(f.selection, { apiVersion: '66.0' });
    await rejects(f, 'INVALID_INPUT');
    expect(f.calls).to.have.length(0);
  });
  it('rejects ambiguous Connect list identities', async () => {
    const f = fixture();
    f.options.pages = [{ offset: 0, totalSize: 2, segments: [f.connect, f.connect] }];
    await rejects(f, 'BLOCKED');
  });
  it('rejects missing or ambiguous Connect details', async () => {
    const f = fixture();
    f.options.details = { segments: [] };
    await rejects(f, 'BLOCKED');
  });
  it('rejects incomplete query results', async () => {
    const f = fixture();
    f.options.queryOverride = () => ({ done: false, totalSize: 1, records: [] });
    await rejects(f, 'BLOCKED');
  });
  it('rejects stalled Connect pagination', async () => {
    const f = fixture();
    f.options.pages = [{ offset: 0, totalSize: 1, segments: [] }];
    await rejects(f, 'BLOCKED');
  });
  it('exhausts separate Connect pages before selecting exact correspondence', async () => {
    const f = fixture();
    f.selection.operation = 'plan';
    const pages = () => [
      { offset: 0, totalSize: 2, segments: [{ ...f.connect, marketSegmentId: id('1sg', 3), apiName: 'Unrelated' }] },
      { offset: 1, totalSize: 2, segments: [f.connect] },
    ];
    f.options.pages = [...pages(), ...pages()];
    expect((await associateFlow(f.selection, f.channel)).state).to.equal('planned');
    expect(f.calls.filter((call) => call.includes('offset=1'))).to.have.length(2);
  });
  it('reconciles changed full native content rather than trusting unchanged start', async () => {
    const f = fixture();
    f.options.onIdentity = (read) => {
      if (read === 3) Object.assign(f.native, { label: 'changed' });
    };
    await rejects(f, 'RECONCILIATION_REQUIRED', true);
  });
  it('rechecks Connect segment-on identity immediately before writing', async () => {
    const f = fixture();
    f.options.onIdentity = (read) => {
      if (read === 2) {
        f.connect.segmentOnId = id('0gj', 3);
        f.detail.segmentOnId = id('0gj', 3);
      }
    };
    await rejects(f, 'CONFLICT');
  });
  it('accepts matching Draft native storage as well as InvalidDraft, without activation', async () => {
    const f = fixture();
    f.native.status = 'Draft';
    f.version.Metadata.status = 'Draft';
    expect((await associateFlow(f.selection, f.channel)).state).to.equal('attached');
  });
});
