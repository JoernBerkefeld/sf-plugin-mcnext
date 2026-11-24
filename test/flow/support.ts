import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Connection } from '@salesforce/core';

export const SEGMENT_ID = '1sgaj000000AAAAAAA';

/** A segment flow as a retrieve returns it: segment by record ID. */
export const FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <actionCalls>
        <name>Send_Email</name>
        <actionName>sendEmailMessage</actionName>
        <inputParameters>
            <name>clickTracking</name>
            <value>
                <booleanValue>true</booleanValue>
            </value>
        </inputParameters>
        <inputParameters>
            <name>contentId</name>
            <value>
                <stringValue>marketing--SourceWorkspace.sfdc_cms__email--Welcome</stringValue>
            </value>
        </inputParameters>
    </actionCalls>
    <actionCalls>
        <name>Send_Second</name>
        <inputParameters><name>contentId</name><value><stringValue>marketing--SourceWorkspace.sfdc_cms__email--Reminder</stringValue></value></inputParameters>
    </actionCalls>
    <apiVersion>68.0</apiVersion>
    <!-- <dataSpace>comment</dataSpace> -->
    <dataSpace>default</dataSpace>
    <label>A &amp; B</label>
    <processMetadataValues>
        <name>status</name>
        <value>
            <stringValue>marketing--Not.sfdc_cms__email--AContentId</stringValue>
        </value>
    </processMetadataValues>
    <start>
        <object>UnifiedssotIndividualMkt__dlm</object>
        <segment>${SEGMENT_ID}</segment>
        <triggerType>Segment</triggerType>
    </start>
    <status>InvalidDraft</status>
</Flow>
`;

/** The same flow as a project file: segment by API name. */
export const FLOW_FILE = FLOW_XML.replace(SEGMENT_ID, 'My_Segment');

export type Row = Record<string, unknown>;
export type Call = { method: string; url: string; body?: unknown };

export type Org = {
  flowRecords: Row[];
  campaigns?: Row[];
  /** With business units, `Campaign` has a `BusinessUnitId` field: the org uses business units. */
  businessUnits?: Row[];
  dataSpaces?: Row[];
  /** Runs instead of the write; throw to simulate a refusal or a lost connection. */
  onWrite?: (call: Call) => void;
  failQuery?: string;
  /** Salesforce answers a write and keeps the old value. */
  ignoreWrites?: boolean;
};

export type Fake = { connection: Connection; queries: string[]; writes: Call[]; org: Org };

function quoted(soql: string): string[] {
  return [...soql.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1].replaceAll("\\'", "'"));
}

/** A connection that answers the FlowRecord and Campaign reads from `org` and applies writes to it. */
export function fakeConnection(org: Org): Fake {
  const queries: string[] = [];
  const writes: Call[] = [];
  const connection = {
    getApiVersion: () => '68.0',
    describe: async (sobject: string) => ({
      fields: [
        { name: 'Id' },
        { name: 'Name' },
        ...(sobject === 'Campaign' && org.businessUnits ? [{ name: 'BusinessUnitId' }] : []),
      ],
    }),
    query: async (soql: string) => {
      queries.push(soql);
      if (org.failQuery && soql.includes(org.failQuery)) throw new Error('INVALID_SESSION_ID');
      const values = quoted(soql);
      let records: Row[];
      if (soql.includes('FROM FlowRecord')) {
        records = soql.includes('ApiName IN')
          ? org.flowRecords.filter((row) => values.includes(row.ApiName as string))
          : org.flowRecords.filter((row) => row.DataSpaceId != null);
      } else if (soql.includes('FROM DataSpace')) {
        records = org.dataSpaces ?? [];
      } else if (soql.includes('FROM BusinessUnit')) {
        records = (org.businessUnits ?? []).filter((row) => values.includes(row.DataSpaceId as string));
      } else {
        const campaigns = org.campaigns ?? [];
        const units = values.slice(1);
        const inBucket = (row: Row): boolean =>
          soql.includes('BusinessUnitId = null')
            ? row.BusinessUnitId == null
            : !soql.includes('BusinessUnitId IN') || units.includes(row.BusinessUnitId as string);
        records = soql.includes(' Id IN')
          ? campaigns.filter((row) => values.includes(row.Id as string))
          : campaigns.filter((row) => (row.Name as string).toLowerCase() === values[0].toLowerCase() && inBucket(row));
      }
      return { done: true, totalSize: records.length, records: records.map((row) => ({ ...row })) };
    },
    request: async (request: { method: string; url: string; body?: string }) => {
      const call: Call = {
        method: request.method,
        url: request.url,
        body: request.body ? JSON.parse(request.body) : undefined,
      };
      writes.push(call);
      org.onWrite?.(call);
      if (org.ignoreWrites) return undefined;
      const id = request.url.split('/').at(-1);
      const index = org.flowRecords.findIndex((row) => row.Id === id);
      if (request.method === 'DELETE') org.flowRecords.splice(index, 1);
      else Object.assign(org.flowRecords[index], call.body);
      return undefined;
    },
  };
  return { connection: connection as unknown as Connection, queries, writes, org };
}

export function flowRecord(apiName: string, more: Row = {}): Row {
  return {
    Id: `2aF00000000${apiName.slice(0, 4).padEnd(4, '0')}AAA`,
    ApiName: apiName,
    DataSpaceId: '0vh000000000001AAA',
    AssociatedRecordId: null,
    ActiveVersionId: null,
    ...more,
  };
}

/** What Salesforce's refusals look like to the caller: an error with an errorCode. */
export function refusal(message: string): Error {
  return Object.assign(new Error(message), { errorCode: 'FIELD_INTEGRITY_EXCEPTION' });
}

const PREFIX = 'mcnext-flow-test-';
const MARKER = '.mcnext-flow-test.json';
const created = new Map<string, string>();

/** A new folder under the OS temp directory, owned by this test run. */
export async function tempFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  const marker = randomUUID();
  await writeFile(join(folder, MARKER), marker, { encoding: 'utf8', flag: 'wx' });
  created.set(folder, marker);
  return folder;
}

/** Removes the folders `tempFolder` created in this run, and only those. */
export async function removeTempFolders(): Promise<void> {
  const root = await realpath(tmpdir());
  for (const [folder, marker] of created) {
    // eslint-disable-next-line no-await-in-loop -- a handful of folders
    const owned =
      dirname(folder) === root &&
      basename(folder).startsWith(PREFIX) &&
      (await readFile(join(folder, MARKER), 'utf8')) === marker;
    // eslint-disable-next-line no-await-in-loop -- a handful of folders
    if (owned) await rm(folder, { recursive: true, force: true });
    created.delete(folder);
  }
}
