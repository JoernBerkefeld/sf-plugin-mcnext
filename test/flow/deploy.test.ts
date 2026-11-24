import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect } from 'chai';
import { statusOf } from '../../src/envelope.js';
import { deployFlows, type DeployFlowsDeps, type DeployFlowsOptions } from '../../src/flow/deploy.js';
import { flowPaths, serializeSidecar, type FlowSidecar } from '../../src/flow/file.js';
import type { FlowDeployment } from '../../src/flow/metadata.js';
import {
  fakeConnection,
  FLOW_FILE,
  FLOW_XML,
  flowRecord,
  refusal,
  removeTempFolders,
  SEGMENT_ID,
  tempFolder,
  type Fake,
  type Org,
} from './support.js';

const CAMPAIGN_ID = '701aj00000ABCDEAAA';
const TARGET_SEGMENT_ID = '1sgaj000000BBBBAAA';

type ContentItem = { type: string; apiName: string; isPublished?: boolean };

type World = {
  /** `dataSpace/apiName` → record ID. */
  segments: Record<string, string>;
  /** Workspace → its items. A workspace that is not listed does not exist. */
  content: Record<string, ContentItem[]>;
  /** What a retrieve of the org's flow returns. */
  orgFlows?: Record<string, string>;
  deployment?: FlowDeployment;
};

type Calls = {
  sent: Array<{ apiName: string; xml: string }>;
  contexts: Array<{ from: string; to: string; names?: readonly string[] }>;
};

const BOTH_EMAILS: ContentItem[] = [
  { type: 'email', apiName: 'Welcome', isPublished: true },
  { type: 'email', apiName: 'Reminder', isPublished: true },
];

const WORLD: World = { segments: { 'default/My_Segment': SEGMENT_ID }, content: { SourceWorkspace: BOTH_EMAILS } };

function deps(world: World, fake: Fake): { deps: DeployFlowsDeps; calls: Calls } {
  const calls: Calls = { sent: [], contexts: [] };
  const getItems: DeployFlowsDeps['getItems'] = async (_connection, { workspace, refs }) => {
    const items = world.content[workspace];
    const answer = {
      status: items ? 'success' : 'failed',
      metadata: {},
      diagnostics: {
        warnings: [],
        errors: items ? [] : [{ code: 'WORKSPACE_NOT_FOUND', message: `No workspace ${workspace}` }],
      },
      result: {
        workspace: { id: '0Zu', apiName: workspace },
        items: refs.map((ref) => {
          const found = (items ?? []).find((item) => item.type === ref.type && item.apiName === ref.apiName);
          return { ...ref, exists: Boolean(found), isPublished: found?.isPublished };
        }),
      },
    };
    return answer as unknown as Awaited<ReturnType<DeployFlowsDeps['getItems']>>;
  };
  return {
    calls,
    deps: {
      getItems,
      resolveSegment: async (_connection, lookup) => {
        const wanted = 'apiName' in lookup ? lookup.apiName : lookup.marketSegmentId;
        const entry = Object.entries(world.segments).find(
          ([key, id]) =>
            key === `${lookup.dataSpace}/${wanted}` || (key.startsWith(`${lookup.dataSpace}/`) && id === wanted)
        );
        if (!entry) throw Object.assign(new Error('Segment lookup failed.'), { code: 'SEGMENT_NOT_FOUND' });
        return { apiName: entry[0].split('/')[1], marketSegmentId: entry[1], dataSpace: lookup.dataSpace };
      },
      crossSpaceContext: async (_connection, spaces) => {
        calls.contexts.push(spaces);
        return {
          source: spaces.from,
          target: spaces.to,
          spaces: [{ name: 'default' }, { name: 'dataspace2', prefix: 'ds2' }],
        };
      },
      retrieveFlow: async (_connection, apiName) => {
        const xml = world.orgFlows?.[apiName];
        return xml === undefined
          ? { ok: false, code: 'FLOW_NOT_FOUND', message: 'none', messages: [] }
          : { ok: true, xml, messages: [] };
      },
      deployFlow: async (_connection, flow) => {
        calls.sent.push(flow);
        const deployment = world.deployment ?? { status: 'succeeded', created: true, messages: [], errors: [] };
        // Salesforce creates the FlowRecord row with the flow.
        if (deployment.status === 'succeeded' && !fake.org.flowRecords.some((row) => row.ApiName === flow.apiName))
          fake.org.flowRecords.push(flowRecord(flow.apiName));
        return deployment;
      },
    },
  };
}

async function project(flows: Record<string, { xml?: string; sidecar?: FlowSidecar }>): Promise<string[]> {
  const root = await tempFolder();
  const files: string[] = [];
  for (const [apiName, flow] of Object.entries(flows)) {
    const paths = flowPaths(root, apiName);
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await mkdir(dirname(paths.xml), { recursive: true });
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await writeFile(paths.xml, flow.xml ?? FLOW_FILE, 'utf8');
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    if (flow.sidecar) await writeFile(paths.sidecar, serializeSidecar(flow.sidecar), 'utf8');
    files.push(paths.xml);
  }
  return files;
}

function options(files: string[], more: Partial<DeployFlowsOptions> = {}): DeployFlowsOptions {
  return {
    files,
    preview: false,
    allowActivation: false,
    metInThisRun: { content: new Set(), campaigns: new Set(), segments: new Set() },
    ...more,
  };
}

async function run(
  org: Org,
  world: World,
  flows: Parameters<typeof project>[0],
  more: Partial<DeployFlowsOptions> = {}
): Promise<{ items: Awaited<ReturnType<typeof deployFlows>>; fake: Fake; calls: Calls }> {
  const fake = fakeConnection(org);
  const built = deps(world, fake);
  const items = await deployFlows(fake.connection, options(await project(flows), more), built.deps);
  return { items, fake, calls: built.calls };
}

const SPRING: FlowSidecar = { campaign: { name: 'Spring' }, needs: [] };

describe('deployFlows', () => {
  afterEach(removeTempFolders);

  describe('checks before anything is sent', () => {
    it('refuses an Active file without allowActivation', async () => {
      const active = FLOW_FILE.replace('<status>InvalidDraft</status>', '<status>Active</status>');
      const { items, calls, fake } = await run({ flowRecords: [] }, WORLD, { WelcomeFlow: { xml: active } });
      expect(items[0]).to.include({
        area: 'mcnext',
        type: 'flow',
        name: 'WelcomeFlow',
        outcome: 'blocked',
        code: 'ACTIVATION_NOT_ALLOWED',
      });
      expect(calls.sent).to.have.length(0);
      expect(fake.writes).to.have.length(0);

      const allowed = await run(
        { flowRecords: [] },
        WORLD,
        { WelcomeFlow: { xml: active } },
        { allowActivation: true, preview: true }
      );
      expect(allowed.items[0].outcome).to.equal('would-create');
    });

    it('blocks a segment the target does not have', async () => {
      const world = { ...WORLD, segments: {} };
      const { items, calls } = await run({ flowRecords: [] }, world, { WelcomeFlow: {} });
      expect(items[0]).to.include({ outcome: 'blocked', code: 'SEGMENT_NOT_FOUND' });
      expect(calls.sent).to.have.length(0);
    });

    it('blocks content the workspace does not have and notes unpublished content', async () => {
      const world = {
        ...WORLD,
        content: { SourceWorkspace: [{ type: 'email', apiName: 'Welcome', isPublished: false }] },
      };
      const { items, calls } = await run({ flowRecords: [] }, world, { WelcomeFlow: {} });
      expect(items[0]).to.include({ outcome: 'blocked', code: 'CONTENT_NOT_FOUND' });
      expect(items[0].message).to.include('Reminder').and.not.include('email Welcome in workspace');
      expect(calls.sent).to.have.length(0);

      const unpublished = {
        ...WORLD,
        content: { SourceWorkspace: [BOTH_EMAILS[0], { ...BOTH_EMAILS[1], isPublished: false }] },
      };
      const preview = await run({ flowRecords: [] }, unpublished, { WelcomeFlow: {} }, { preview: true });
      expect(preview.items[0].outcome).to.equal('would-create');
      expect(preview.items[0].message).to.include('Reminder').and.include('not published');
    });

    it('fails when the workspace cannot be read', async () => {
      const { items } = await run({ flowRecords: [] }, { ...WORLD, content: {} }, { WelcomeFlow: {} });
      expect(items[0]).to.include({ outcome: 'failed', code: 'WORKSPACE_NOT_FOUND' });
    });

    it('blocks a campaign that does not exist or exists twice', async () => {
      const missing = await run({ flowRecords: [], campaigns: [] }, WORLD, { WelcomeFlow: { sidecar: SPRING } });
      expect(missing.items[0]).to.include({ outcome: 'blocked', code: 'CAMPAIGN_NOT_FOUND' });

      const twice = await run(
        {
          flowRecords: [],
          campaigns: [
            { Id: CAMPAIGN_ID, Name: 'Spring' },
            { Id: '701aj00000ZZZZZAAA', Name: 'Spring' },
          ],
        },
        WORLD,
        { WelcomeFlow: { sidecar: SPRING } }
      );
      expect(twice.items[0]).to.include({ outcome: 'blocked', code: 'CAMPAIGN_NAME_AMBIGUOUS' });
      expect(twice.calls.sent).to.have.length(0);

      // Another spelling is another campaign.
      const spelled = await run({ flowRecords: [], campaigns: [{ Id: CAMPAIGN_ID, Name: 'SPRING' }] }, WORLD, {
        WelcomeFlow: { sidecar: SPRING },
      });
      expect(spelled.items[0].code).to.equal('CAMPAIGN_NOT_FOUND');
    });

    describe('in an org with business units', () => {
      const DEFAULT_UNIT = '1QO000000000001AAA';
      const OTHER_UNIT = '1QO000000000002AAA';
      const IN_DEFAULT = { Id: CAMPAIGN_ID, Name: 'Spring', BusinessUnitId: DEFAULT_UNIT };
      const IN_OTHER = { Id: '701aj00000OTHERAAA', Name: 'Spring', BusinessUnitId: OTHER_UNIT };
      const WITHOUT = { Id: '701aj00000NONE0AAA', Name: 'Spring', BusinessUnitId: null };
      const units = {
        businessUnits: [
          { Id: DEFAULT_UNIT, DeveloperName: 'defaultBusinessUnit', DataSpaceId: '0vh000000000001AAA' },
          { Id: OTHER_UNIT, DeveloperName: 'otherBusinessUnit', DataSpaceId: '0vh000000000002AAA' },
        ],
        dataSpaces: [
          { Id: '0vh000000000001AAA', Name: 'default' },
          { Id: '0vh000000000002AAA', Name: 'dataspace2' },
        ],
      };
      const linked = (fake: Fake): unknown =>
        (fake.writes[0]?.body as { AssociatedRecordId?: string } | undefined)?.AssociatedRecordId;
      const flows = { WelcomeFlow: { sidecar: SPRING } };

      it('attaches the flow to the campaign of the business unit that owns its data space', async () => {
        // The flow file is in data space "default", which belongs to defaultBusinessUnit.
        const { items, fake } = await run(
          { flowRecords: [], campaigns: [IN_OTHER, WITHOUT, IN_DEFAULT], ...units },
          WORLD,
          flows
        );
        expect(items[0].outcome).to.equal('created');
        expect(linked(fake)).to.equal(IN_DEFAULT.Id);
        expect(
          fake.queries.some((soql) => soql.includes(`Name = 'Spring' AND BusinessUnitId IN ('${DEFAULT_UNIT}')`))
        ).to.equal(true);
      });

      it('falls back to the campaign without a business unit, never to one of another business unit', async () => {
        const fallback = await run({ flowRecords: [], campaigns: [IN_OTHER, WITHOUT], ...units }, WORLD, flows);
        expect(fallback.items[0].outcome).to.equal('created');
        expect(linked(fallback.fake)).to.equal(WITHOUT.Id);

        const elsewhere = await run({ flowRecords: [], campaigns: [IN_OTHER], ...units }, WORLD, flows);
        expect(elsewhere.items[0]).to.include({ outcome: 'blocked', code: 'CAMPAIGN_NOT_FOUND' });
        expect(elsewhere.items[0].message).to.include(
          'in business unit defaultBusinessUnit or without a business unit'
        );
        expect(elsewhere.calls.sent).to.have.length(0);
      });

      it('blocks several campaigns of that name in the chosen place only', async () => {
        const twin = { ...IN_DEFAULT, Id: '701aj00000TWIN0AAA' };
        const inUnit = await run({ flowRecords: [], campaigns: [IN_DEFAULT, twin, WITHOUT], ...units }, WORLD, flows);
        expect(inUnit.items[0]).to.include({ outcome: 'blocked', code: 'CAMPAIGN_NAME_AMBIGUOUS' });
        expect(inUnit.items[0].message).to.include('in business unit defaultBusinessUnit');

        const none = await run(
          { flowRecords: [], campaigns: [WITHOUT, { ...WITHOUT, Id: '701aj00000NONE1AAA' }, IN_OTHER], ...units },
          WORLD,
          flows
        );
        expect(none.items[0]).to.include({ outcome: 'blocked', code: 'CAMPAIGN_NAME_AMBIGUOUS' });
        expect(none.items[0].message).to.include('without a business unit');

        // Namesakes in other places do not make the name ambiguous.
        const clear = await run(
          {
            flowRecords: [],
            campaigns: [IN_DEFAULT, IN_OTHER, WITHOUT, { ...WITHOUT, Id: '701aj00000NONE1AAA' }],
            ...units,
          },
          WORLD,
          flows
        );
        expect(linked(clear.fake)).to.equal(IN_DEFAULT.Id);
      });

      it('looks in the business unit of the target data space for a copy', async () => {
        const world: World = {
          ...WORLD,
          segments: { 'dataspace2/ds2_My_Segment': TARGET_SEGMENT_ID },
          content: { TargetWorkspace: BOTH_EMAILS },
        };
        const target = { dataSpace: 'dataspace2', workspaceFor: () => 'TargetWorkspace' };
        const { items, fake } = await run(
          { flowRecords: [], campaigns: [IN_DEFAULT, IN_OTHER], ...units },
          world,
          flows,
          { target }
        );
        expect(items[0].outcome).to.equal('created');
        expect(linked(fake)).to.equal(IN_OTHER.Id);
      });

      it('counts a campaign of this run only in the business unit of the flow, or without one', async () => {
        const preview = (campaigns: string[]) =>
          run({ flowRecords: [], campaigns: [IN_OTHER], ...units }, WORLD, flows, {
            preview: true,
            metInThisRun: { content: new Set(), segments: new Set(), campaigns: new Set(campaigns) },
          });
        const sameUnit = await preview(['defaultbusinessunit/Spring']);
        expect(sameUnit.items[0].outcome).to.equal('would-create');
        expect(sameUnit.items[0].message).to.include('Campaign Spring is created in this run');
        expect((await preview(['/Spring'])).items[0].outcome).to.equal('would-create');
        expect((await preview(['otherbusinessunit/Spring'])).items[0].code).to.equal('CAMPAIGN_NOT_FOUND');
      });

      it('fails when the business unit of the data space cannot be read', async () => {
        const { items, calls } = await run(
          { flowRecords: [], campaigns: [IN_DEFAULT], ...units, failQuery: 'FROM BusinessUnit' },
          WORLD,
          flows
        );
        expect(items[0]).to.include({ outcome: 'failed', code: 'CAMPAIGN_READ_FAILED' });
        expect(calls.sent).to.have.length(0);
      });
    });

    it('goes by the name alone in an org without business units, whatever business unit this run names', async () => {
      const met = {
        content: new Set<string>(),
        segments: new Set<string>(),
        campaigns: new Set(['otherbusinessunit/Spring']),
      };
      const { items, fake } = await run(
        { flowRecords: [], campaigns: [] },
        WORLD,
        { WelcomeFlow: { sidecar: SPRING } },
        { preview: true, metInThisRun: met }
      );
      expect(items[0].outcome).to.equal('would-create');
      expect(fake.queries.join(' ')).to.not.include('BusinessUnit');
    });

    it('reports a sidecar that cannot be read', async () => {
      const files = await project({ WelcomeFlow: {} });
      await writeFile(files[0].replace('.flow-meta.xml', '.flow.json'), '{"campaign":1}', 'utf8');
      const fake = fakeConnection({ flowRecords: [] });
      const items = await deployFlows(fake.connection, options(files), deps(WORLD, fake).deps);
      expect(items[0]).to.include({ outcome: 'failed', code: 'FLOW_SIDECAR_INVALID' });
    });
  });

  describe('needs met in this run', () => {
    const empty: World = { segments: {}, content: { SourceWorkspace: [] } };
    const met = {
      segments: new Set(['default/My_Segment']),
      content: new Set(['SourceWorkspace/email/Welcome', 'SourceWorkspace/email/Reminder']),
      campaigns: new Set(['/Spring']),
    };

    it('count as met in a preview', async () => {
      const { items, calls, fake } = await run(
        { flowRecords: [], campaigns: [] },
        empty,
        { WelcomeFlow: { sidecar: SPRING } },
        { preview: true, metInThisRun: met }
      );
      expect(items[0].outcome).to.equal('would-create');
      expect(items[0].message).to.include('My_Segment').and.include('Spring').and.include('Welcome');
      expect(calls.sent).to.have.length(0);
      expect(fake.writes).to.have.length(0);
    });

    it('are reported as an update, never as unchanged, when the flow exists', async () => {
      const { items } = await run(
        { flowRecords: [flowRecord('WelcomeFlow')] },
        { ...empty, orgFlows: { WelcomeFlow: FLOW_FILE } },
        { WelcomeFlow: {} },
        { preview: true, metInThisRun: met }
      );
      expect(items[0].outcome).to.equal('would-update');
    });

    it('do not replace the check directly before a flow is sent', async () => {
      const { items, calls } = await run(
        { flowRecords: [], campaigns: [] },
        empty,
        { WelcomeFlow: { sidecar: SPRING } },
        { metInThisRun: met }
      );
      expect(items[0]).to.include({ outcome: 'blocked', code: 'SEGMENT_NOT_FOUND' });
      expect(calls.sent).to.have.length(0);
    });
  });

  describe('preview', () => {
    it('tells create, update and unchanged apart without a write', async () => {
      const org: Org = { flowRecords: [flowRecord('SameFlow'), flowRecord('ChangedFlow')] };
      const world = { ...WORLD, orgFlows: { SameFlow: FLOW_XML, ChangedFlow: FLOW_XML.replace('A &amp; B', 'Older') } };
      const { items, calls, fake } = await run(
        org,
        world,
        { NewFlow: {}, SameFlow: {}, ChangedFlow: {} },
        { preview: true }
      );
      expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([
        ['NewFlow', 'would-create'],
        ['SameFlow', 'unchanged'],
        ['ChangedFlow', 'would-update'],
      ]);
      expect(calls.sent).to.have.length(0);
      expect(fake.writes).to.have.length(0);
    });

    it('reports a missing campaign link as an update', async () => {
      const org: Org = { flowRecords: [flowRecord('SameFlow')], campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }] };
      const { items } = await run(
        org,
        { ...WORLD, orgFlows: { SameFlow: FLOW_XML } },
        { SameFlow: { sidecar: SPRING } },
        { preview: true }
      );
      expect(items[0].outcome).to.equal('would-update');
    });
  });

  describe('copy into another business unit', () => {
    const target = {
      dataSpace: 'dataspace2',
      workspaceFor: (source: string) => (source === 'SourceWorkspace' ? 'TargetWorkspace' : undefined),
    };
    const world: World = {
      segments: { 'dataspace2/ds2_My_Segment': TARGET_SEGMENT_ID },
      content: { TargetWorkspace: BOTH_EMAILS },
    };

    it('rewrites data space, workspace, segment and start object', async () => {
      const { items, calls } = await run({ flowRecords: [] }, world, { WelcomeFlow: {} }, { target });
      expect(items[0].outcome).to.equal('created');
      expect(calls.contexts).to.deep.equal([
        { from: 'default', to: 'dataspace2', names: ['UnifiedssotIndividualMkt__dlm'] },
      ]);
      expect(calls.sent[0].xml).to.equal(
        FLOW_FILE.replace('<dataSpace>default<', '<dataSpace>dataspace2<')
          .replaceAll('marketing--SourceWorkspace.', 'marketing--TargetWorkspace.')
          .replace('<segment>My_Segment<', `<segment>${TARGET_SEGMENT_ID}<`)
          .replace('<object>UnifiedssotIndividualMkt__dlm<', '<object>ds2_UnifiedIndividualMkt__dlm<')
      );
    });

    it('changes the workspace only when the data space stays', async () => {
      const same = { ...target, dataSpace: 'default' };
      const { calls } = await run(
        { flowRecords: [] },
        { ...WORLD, content: { TargetWorkspace: BOTH_EMAILS } },
        { WelcomeFlow: {} },
        { target: same }
      );
      expect(calls.contexts).to.have.length(0);
      expect(calls.sent[0].xml).to.equal(
        FLOW_FILE.replaceAll('marketing--SourceWorkspace.', 'marketing--TargetWorkspace.').replace(
          '<segment>My_Segment<',
          `<segment>${SEGMENT_ID}<`
        )
      );
    });

    it('blocks when no workspace is chosen or a name cannot be placed', async () => {
      const noWorkspace = await run(
        { flowRecords: [] },
        world,
        { WelcomeFlow: {} },
        { target: { ...target, workspaceFor: () => undefined } }
      );
      expect(noWorkspace.items[0]).to.include({ outcome: 'blocked', code: 'WORKSPACE_REQUIRED' });

      const packaged = FLOW_FILE.replace('UnifiedssotIndividualMkt__dlm', 'ns__Thing__dlm');
      const notPlaced = await run({ flowRecords: [] }, world, { WelcomeFlow: { xml: packaged } }, { target });
      expect(notPlaced.items[0]).to.include({ outcome: 'blocked', code: 'OBJECT_NOT_PLACED' });
      expect(notPlaced.calls.sent).to.have.length(0);
    });
  });

  describe('real run', () => {
    it('sends the flow with the segment ID, attaches the campaign and reads the link back', async () => {
      const world: World = {
        ...WORLD,
        deployment: { status: 'succeeded', created: true, messages: ['Select a valid From address.'], errors: [] },
      };
      const { items, calls, fake } = await run(
        { flowRecords: [], campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }] },
        world,
        { WelcomeFlow: { sidecar: SPRING } }
      );
      expect(calls.sent).to.have.length(1);
      expect(calls.sent[0]).to.deep.equal({ apiName: 'WelcomeFlow', xml: FLOW_XML });
      const record = fake.org.flowRecords[0];
      expect(fake.writes).to.deep.equal([
        {
          method: 'PATCH',
          url: `/services/data/v68.0/sobjects/FlowRecord/${record.Id as string}`,
          body: { AssociatedRecordId: CAMPAIGN_ID },
        },
      ]);
      expect(record.AssociatedRecordId).to.equal(CAMPAIGN_ID);
      expect(items[0]).to.include({ outcome: 'created', id: record.Id, message: 'Select a valid From address.' });
      // The link is read again after the write.
      expect(fake.queries.at(-1)).to.include('FROM FlowRecord');
      expect(fake.queries.filter((soql) => soql.includes('FROM FlowRecord'))).to.have.length(3);
    });

    it('updates an existing flow and leaves a link that is already right', async () => {
      const org: Org = {
        flowRecords: [flowRecord('WelcomeFlow', { AssociatedRecordId: CAMPAIGN_ID.slice(0, 15) })],
        campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }],
      };
      const world = { ...WORLD, orgFlows: { WelcomeFlow: FLOW_XML.replace('A &amp; B', 'Older') } };
      const { items, calls, fake } = await run(org, world, { WelcomeFlow: { sidecar: SPRING } });
      expect(items[0].outcome).to.equal('updated');
      expect(calls.sent).to.have.length(1);
      expect(fake.writes).to.have.length(0);
    });

    it('sends nothing when flow and link are as in the file', async () => {
      const org: Org = {
        flowRecords: [flowRecord('WelcomeFlow', { AssociatedRecordId: CAMPAIGN_ID })],
        campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }],
      };
      const { items, calls, fake } = await run(
        org,
        { ...WORLD, orgFlows: { WelcomeFlow: FLOW_XML } },
        { WelcomeFlow: { sidecar: SPRING } }
      );
      expect(items[0].outcome).to.equal('unchanged');
      expect(calls.sent).to.have.length(0);
      expect(fake.writes).to.have.length(0);
    });

    it('only attaches the campaign when the flow itself is unchanged', async () => {
      const org: Org = { flowRecords: [flowRecord('WelcomeFlow')], campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }] };
      const { items, calls, fake } = await run(
        org,
        { ...WORLD, orgFlows: { WelcomeFlow: FLOW_XML } },
        { WelcomeFlow: { sidecar: SPRING } }
      );
      expect(items[0].outcome).to.equal('updated');
      expect(calls.sent).to.have.length(0);
      expect(fake.writes).to.have.length(1);
    });

    it('reports a refused deploy and does not attempt the flows after it', async () => {
      const world: World = {
        ...WORLD,
        deployment: { status: 'failed', requestStatus: 'Failed', messages: [], errors: ['invalid parameter value'] },
      };
      const { items, calls } = await run({ flowRecords: [] }, world, { FirstFlow: {}, SecondFlow: {} });
      expect(items.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
        ['FirstFlow', 'failed', 'FLOW_DEPLOY_FAILED'],
        ['SecondFlow', 'not-attempted', undefined],
      ]);
      expect(items[0].message).to.equal('invalid parameter value');
      expect(calls.sent).to.have.length(1);
    });

    it('reports unknown when no answer comes back, and sends the flow once', async () => {
      const world: World = { ...WORLD, deployment: { status: 'unknown', messages: [], errors: ['socket hang up'] } };
      const { items, calls } = await run({ flowRecords: [] }, world, { WelcomeFlow: {} });
      expect(items[0]).to.include({ outcome: 'unknown', code: 'FLOW_DEPLOY_UNKNOWN' });
      expect(calls.sent).to.have.length(1);
    });

    it('tells a refused link from one without an answer, and sends it once', async () => {
      const campaigns = [{ Id: CAMPAIGN_ID, Name: 'Spring' }];
      const refused = await run(
        {
          flowRecords: [],
          campaigns,
          onWrite: () => {
            throw refusal('Data Space does not match');
          },
        },
        WORLD,
        { WelcomeFlow: { sidecar: SPRING } }
      );
      // The deployed flow keeps its written outcome; the link is its own item.
      expect(refused.items).to.have.length(2);
      expect(refused.items[0]).to.include({ type: 'flow', name: 'WelcomeFlow', outcome: 'created' });
      expect(refused.items[1]).to.include({
        area: 'mcnext',
        type: 'campaign-link',
        name: 'WelcomeFlow',
        outcome: 'failed',
        code: 'CAMPAIGN_LINK_FAILED',
      });
      expect(refused.items[1].message)
        .to.include('The flow itself is deployed.')
        .and.include('Data Space does not match');
      expect(statusOf(refused.items, [])).to.equal(68);

      const lost = await run(
        {
          flowRecords: [],
          campaigns,
          onWrite: () => {
            throw new Error('ECONNRESET');
          },
        },
        WORLD,
        { WelcomeFlow: { sidecar: SPRING } }
      );
      expect(lost.items[0]).to.include({ type: 'flow', outcome: 'created' });
      expect(lost.items[1]).to.include({ type: 'campaign-link', outcome: 'unknown', code: 'CAMPAIGN_LINK_UNKNOWN' });
      expect(lost.fake.writes).to.have.length(1);
    });

    it('stops after a failed link and reports an unchanged flow whose link failed as status 1', async () => {
      const org: Org = {
        flowRecords: [flowRecord('WelcomeFlow')],
        campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }],
        onWrite: () => {
          throw refusal('Data Space does not match');
        },
      };
      const { items } = await run(
        org,
        { ...WORLD, orgFlows: { WelcomeFlow: FLOW_XML } },
        { WelcomeFlow: { sidecar: SPRING }, SecondFlow: {} }
      );
      expect(items.map((item) => `${item.type}:${item.outcome}`)).to.deep.equal([
        'flow:unchanged',
        'campaign-link:failed',
        'flow:not-attempted',
      ]);
      expect(items[1].message).to.not.include('The flow itself is deployed.');
      expect(statusOf(items, [])).to.equal(1);
    });

    it('fails when the link does not read back', async () => {
      const fake = fakeConnection({
        flowRecords: [],
        campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }],
        ignoreWrites: true,
      });
      const items = await deployFlows(
        fake.connection,
        options(await project({ WelcomeFlow: { sidecar: SPRING } })),
        deps(WORLD, fake).deps
      );
      expect(items[0]).to.include({ type: 'flow', outcome: 'created' });
      expect(items[1]).to.include({ type: 'campaign-link', outcome: 'failed', code: 'CAMPAIGN_LINK_NOT_CONFIRMED' });
    });
  });
});
