import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect } from 'chai';
import { flowPaths, parseSidecar } from '../../src/flow/file.js';
import { retrieveFlows, type RetrieveFlowsDeps } from '../../src/flow/retrieve.js';
import type { SegmentRow } from '../../src/libraries.js';
import {
  fakeConnection,
  FLOW_FILE,
  FLOW_XML,
  flowRecord,
  removeTempFolders,
  SEGMENT_ID,
  tempFolder,
} from './support.js';

const CAMPAIGN_ID = '701aj00000ABCDEAAA';

const DEFAULT_SPACE = '0vh000000000001AAA';
const OTHER_SPACE = '0vh000000000002AAA';

type Calls = { retrieved: string[]; segmentLists: string[]; dataSpaceReads: number };

function deps(
  flows: Record<string, string>,
  segments: SegmentRow[] | Error
): { deps: RetrieveFlowsDeps; calls: Calls } {
  const calls: Calls = { retrieved: [], segmentLists: [], dataSpaceReads: 0 };
  return {
    calls,
    deps: {
      retrieveFlow: async (_connection, apiName) => {
        calls.retrieved.push(apiName);
        return apiName in flows
          ? { ok: true, xml: flows[apiName], messages: [] }
          : {
              ok: false,
              code: 'FLOW_RETRIEVE_FAILED',
              message: `Flow ${apiName} could not be retrieved: timeout`,
              messages: [],
            };
      },
      listSegments: async (_connection, { dataSpace }) => {
        calls.segmentLists.push(dataSpace);
        if (segments instanceof Error) throw segments;
        return segments;
      },
      // The label of the second data space ("Second") differs from its API name.
      readDataSpaceNames: async () => {
        calls.dataSpaceReads += 1;
        return new Map([
          [DEFAULT_SPACE, 'default'],
          [OTHER_SPACE, 'dataspace2'],
        ]);
      },
    },
  };
}

const SEGMENTS: SegmentRow[] = [{ apiName: 'My_Segment', marketSegmentId: SEGMENT_ID, dataSpace: 'default' }];

describe('retrieveFlows', () => {
  afterEach(removeTempFolders);

  it('writes every marketing flow with the segment by name and a sidecar', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({
      flowRecords: [
        flowRecord('WelcomeFlow', { AssociatedRecordId: CAMPAIGN_ID }),
        flowRecord('SecondFlow', { AssociatedRecordId: '0Xx000000000001AAA' }),
        flowRecord('ScreenFlow', { DataSpaceId: null }),
      ],
      campaigns: [{ Id: CAMPAIGN_ID, Name: 'Spring' }],
    });
    const fake = deps({ WelcomeFlow: FLOW_XML, SecondFlow: FLOW_XML }, SEGMENTS);

    const items = await retrieveFlows(connection, { outputDir }, fake.deps);

    expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([
      ['WelcomeFlow', 'retrieved'],
      ['SecondFlow', 'retrieved'],
    ]);
    expect(fake.calls.retrieved).to.deep.equal(['WelcomeFlow', 'SecondFlow']);
    expect(fake.calls.segmentLists).to.deep.equal(['default']);
    const paths = flowPaths(outputDir, 'WelcomeFlow');
    expect(items[0]).to.include({ area: 'mcnext', type: 'flow', path: paths.xml });
    expect(await readFile(paths.xml, 'utf8')).to.equal(FLOW_FILE);
    expect(parseSidecar(await readFile(paths.sidecar, 'utf8'))).to.deep.equal({
      campaign: { name: 'Spring' },
      needs: [
        { kind: 'segment', name: 'My_Segment', dataSpace: 'default' },
        { kind: 'content', type: 'email', apiName: 'Welcome', workspace: 'SourceWorkspace' },
        { kind: 'content', type: 'email', apiName: 'Reminder', workspace: 'SourceWorkspace' },
      ],
    });
    const second = parseSidecar(await readFile(flowPaths(outputDir, 'SecondFlow').sidecar, 'utf8'));
    expect(second.campaign).to.equal(undefined);
  });

  it('keeps to the data space of a record ID, whatever the data space is called', async () => {
    const outputDir = await tempFolder();
    const { connection, queries } = fakeConnection({
      flowRecords: [flowRecord('InDefault'), flowRecord('InOther', { DataSpaceId: OTHER_SPACE })],
    });
    const fake = deps({ InDefault: FLOW_XML, InOther: FLOW_XML }, SEGMENTS);
    // The 15-character form of the ID is the same data space.
    const items = await retrieveFlows(
      connection,
      { outputDir, dataSpace: 'dataspace2', dataSpaceId: OTHER_SPACE.slice(0, 15) },
      fake.deps
    );
    expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([['InOther', 'retrieved']]);
    expect(fake.calls.dataSpaceReads).to.equal(0);
    expect(queries.join(' ')).to.not.include('DataSpace.Name');
  });

  it('resolves a data space given by API name to its record ID', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({
      flowRecords: [flowRecord('InDefault'), flowRecord('InOther', { DataSpaceId: OTHER_SPACE })],
    });
    const fake = deps({ InDefault: FLOW_XML, InOther: FLOW_XML }, SEGMENTS);
    const items = await retrieveFlows(connection, { outputDir, dataSpace: 'DataSpace2' }, fake.deps);
    expect(items.map((item) => item.name)).to.deep.equal(['InOther']);
    expect(fake.calls.dataSpaceReads).to.equal(1);

    // A label is not an API name: nothing is retrieved under it.
    const byLabel = await retrieveFlows(
      connection,
      { outputDir, dataSpace: 'Second', apiNames: ['InOther'] },
      fake.deps
    );
    expect(byLabel.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
      ['InOther', 'failed', 'DATA_SPACE_NOT_FOUND'],
    ]);
    const everything = await retrieveFlows(connection, { outputDir, dataSpace: 'Second' }, fake.deps);
    expect(everything.map((item) => [item.outcome, item.code])).to.deep.equal([['failed', 'DATA_SPACE_NOT_FOUND']]);
    expect(fake.calls.retrieved).to.deep.equal(['InOther']);
  });

  it('reports a named flow of another data space as failed instead of dropping it', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({
      flowRecords: [
        flowRecord('InDefault'),
        flowRecord('InOther', { DataSpaceId: OTHER_SPACE }),
        flowRecord('ScreenFlow', { DataSpaceId: null }),
      ],
    });
    const fake = deps({ InDefault: FLOW_XML, InOther: FLOW_XML, ScreenFlow: FLOW_FILE }, SEGMENTS);
    const items = await retrieveFlows(
      connection,
      {
        outputDir,
        apiNames: ['InDefault', 'InOther', 'ScreenFlow', 'MissingFlow'],
        dataSpace: 'dataspace2',
        dataSpaceId: OTHER_SPACE,
      },
      fake.deps
    );
    expect(items.map((item) => [item.name, item.outcome, item.code])).to.have.deep.members([
      ['MissingFlow', 'failed', 'FLOW_NOT_FOUND'],
      ['InDefault', 'failed', 'FLOW_OTHER_DATASPACE'],
      ['ScreenFlow', 'failed', 'FLOW_OTHER_DATASPACE'],
      ['InOther', 'retrieved', undefined],
    ]);
    const outside = items.find((item) => item.name === 'InDefault');
    expect(outside?.message).to.include('dataspace2');
    expect(outside?.id).to.be.a('string');
    expect(fake.calls.retrieved).to.deep.equal(['InOther']);
  });

  it('returns failed items when the data spaces cannot be read', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({ flowRecords: [flowRecord('InDefault')] });
    const fake = deps({ InDefault: FLOW_XML }, SEGMENTS);
    fake.deps.readDataSpaceNames = async () => {
      throw new Error('INVALID_SESSION_ID');
    };
    const items = await retrieveFlows(
      connection,
      { outputDir, dataSpace: 'default', apiNames: ['InDefault'] },
      fake.deps
    );
    expect(items.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
      ['InDefault', 'failed', 'FLOW_READ_FAILED'],
    ]);
    expect(fake.calls.retrieved).to.deep.equal([]);
  });

  it('keeps a segment ID that resolves to nothing and says so', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({ flowRecords: [flowRecord('WelcomeFlow')] });
    const [item] = await retrieveFlows(connection, { outputDir }, deps({ WelcomeFlow: FLOW_XML }, []).deps);
    expect(item.outcome).to.equal('retrieved');
    expect(item.message).to.include(SEGMENT_ID);
    const paths = flowPaths(outputDir, 'WelcomeFlow');
    expect(await readFile(paths.xml, 'utf8')).to.equal(FLOW_XML);
    expect(parseSidecar(await readFile(paths.sidecar, 'utf8')).needs.map((need) => need.kind)).to.deep.equal([
      'content',
      'content',
    ]);
  });

  it('reports a named flow the org does not have, and one that cannot be retrieved', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({
      flowRecords: [flowRecord('BrokenFlow'), flowRecord('ScreenFlow', { DataSpaceId: null })],
    });
    const fake = deps({ ScreenFlow: FLOW_FILE }, SEGMENTS);
    const items = await retrieveFlows(
      connection,
      { outputDir, apiNames: ['MissingFlow', 'BrokenFlow', 'ScreenFlow'] },
      fake.deps
    );
    expect(items.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
      ['MissingFlow', 'failed', 'FLOW_NOT_FOUND'],
      ['BrokenFlow', 'failed', 'FLOW_RETRIEVE_FAILED'],
      ['ScreenFlow', 'retrieved', undefined],
    ]);
    // A file that already names its segment needs no segment list.
    expect(fake.calls.segmentLists).to.deep.equal([]);
  });

  it('fails the flow when the segment list cannot be read', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({ flowRecords: [flowRecord('WelcomeFlow')] });
    const error = Object.assign(new Error('Segment lookup failed.'), { code: 'SEGMENT_ACQUISITION_FAILED' });
    const [item] = await retrieveFlows(connection, { outputDir }, deps({ WelcomeFlow: FLOW_XML }, error).deps);
    expect(item).to.include({ outcome: 'failed', code: 'SEGMENT_ACQUISITION_FAILED' });
  });

  it('replaces existing files', async () => {
    const outputDir = await tempFolder();
    const paths = flowPaths(outputDir, 'WelcomeFlow');
    await mkdir(dirname(paths.xml), { recursive: true });
    await writeFile(paths.xml, 'old', 'utf8');
    await writeFile(paths.sidecar, 'old', 'utf8');
    const { connection } = fakeConnection({ flowRecords: [flowRecord('WelcomeFlow')] });
    await retrieveFlows(connection, { outputDir }, deps({ WelcomeFlow: FLOW_XML }, SEGMENTS).deps);
    expect(await readFile(paths.xml, 'utf8')).to.equal(FLOW_FILE);
    expect(await readFile(paths.sidecar, 'utf8')).to.include('"needs"');
  });

  it('returns a failed item when the flow list cannot be read', async () => {
    const outputDir = await tempFolder();
    const { connection } = fakeConnection({ flowRecords: [], failQuery: 'FROM FlowRecord' });
    const items = await retrieveFlows(connection, { outputDir, apiNames: ['A'] }, deps({}, SEGMENTS).deps);
    expect(items).to.have.length(1);
    expect(items[0]).to.include({ name: 'A', outcome: 'failed', code: 'FLOW_READ_FAILED' });
  });
});
