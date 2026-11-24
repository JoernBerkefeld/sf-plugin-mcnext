import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { pickWorkspace, readBusinessUnits, resolveBusinessUnit } from '../src/business-units.js';

type Space = { id: string; apiName?: string | null };
type Page = { spaces: Space[]; nextPageUrl?: string | null };

type Org = {
  campaignFields: string[];
  businessUnitFields?: string[];
  dataSpaceFields?: string[];
  businessUnits: Array<Record<string, unknown>>;
  dataSpaces: Array<Record<string, unknown>>;
  /** Pages of the spaces list per business unit ID. */
  spaces?: Record<string, Page[]>;
  failQuery?: string;
};

type Fake = { connection: Connection; queries: string[]; requests: string[] };

function fakeConnection(org: Org): Fake {
  const queries: string[] = [];
  const requests: string[] = [];
  const fields: Record<string, string[]> = {
    Campaign: org.campaignFields,
    BusinessUnit: org.businessUnitFields ?? ['Id', 'DeveloperName', 'MasterLabel', 'DataSpaceId'],
    DataSpace: org.dataSpaceFields ?? ['Id', 'Name', 'DataSpaceApiName'],
  };
  const connection = {
    getApiVersion: () => '68.0',
    describe: async (sobject: string) => ({ fields: fields[sobject].map((name) => ({ name })) }),
    query: async (soql: string) => {
      queries.push(soql);
      if (org.failQuery && soql.includes(org.failQuery)) throw new Error('INVALID_SESSION_ID');
      const records = soql.includes('FROM BusinessUnit') ? org.businessUnits : org.dataSpaces;
      return { done: true, totalSize: records.length, records };
    },
    request: async (url: string) => {
      requests.push(url);
      const parsed = new URL(url, 'https://org.example');
      const pages = org.spaces?.[parsed.searchParams.get('businessUnitId') ?? ''] ?? [];
      return pages[Number(parsed.searchParams.get('page'))] ?? { spaces: [], nextPageUrl: null };
    },
  };
  return { connection: connection as unknown as Connection, queries, requests };
}

const ENABLED: Org = {
  campaignFields: ['Id', 'Name', 'BusinessUnitId'],
  businessUnits: [
    { Id: '1QO000000000001', DeveloperName: 'defaultBusinessUnit', MasterLabel: 'Default', DataSpaceId: '0vh1' },
    { Id: '1QO000000000002', DeveloperName: 'otherBusinessUnit', MasterLabel: 'Other', DataSpaceId: '0vh2' },
  ],
  dataSpaces: [
    { Id: '0vh1', Name: 'Default Space', DataSpaceApiName: 'default' },
    { Id: '0vh2', Name: 'Second', DataSpaceApiName: 'dataspace2' },
  ],
  spaces: {
    '1QO000000000001': [
      { spaces: [{ id: '0Zu1', apiName: 'Cloud_Kicks' }], nextPageUrl: '/next' },
      { spaces: [{ id: '0Zu2', apiName: 'Default_Content_Workspace' }], nextPageUrl: null },
    ],
    '1QO000000000002': [{ spaces: [{ id: '0Zu3', apiName: 'otherMarketing' }], nextPageUrl: null }],
  },
};

const DISABLED: Org = {
  campaignFields: ['Id', 'Name'],
  businessUnits: [
    {
      Id: '1QO000000000009',
      DeveloperName: 'defaultBusinessUnit',
      MasterLabel: 'default Business Unit',
      DataSpaceId: '0vh1',
    },
  ],
  dataSpaces: ENABLED.dataSpaces,
};

describe('readBusinessUnits', () => {
  it('lists business units with data space and workspaces across pages', async () => {
    const fake = fakeConnection(ENABLED);
    const listing = await readBusinessUnits(fake.connection);
    expect(listing).to.deep.equal({
      businessUnitsEnabled: true,
      businessUnits: [
        {
          id: '1QO000000000001',
          developerName: 'defaultBusinessUnit',
          label: 'Default',
          dataSpace: 'default',
          dataSpaceId: '0vh1',
          workspaces: ['Cloud_Kicks', 'Default_Content_Workspace'],
        },
        {
          id: '1QO000000000002',
          developerName: 'otherBusinessUnit',
          label: 'Other',
          dataSpace: 'dataspace2',
          dataSpaceId: '0vh2',
          workspaces: ['otherMarketing'],
        },
      ],
      warnings: [],
    });
    expect(fake.queries).to.deep.equal([
      'SELECT Id, DeveloperName, MasterLabel, DataSpaceId FROM BusinessUnit ORDER BY DeveloperName',
      'SELECT Id, DataSpaceApiName FROM DataSpace',
    ]);
    expect(fake.requests).to.deep.equal([
      '/services/data/v68.0/connect/cms/spaces?businessUnitId=1QO000000000001&page=0',
      '/services/data/v68.0/connect/cms/spaces?businessUnitId=1QO000000000001&page=1',
      '/services/data/v68.0/connect/cms/spaces?businessUnitId=1QO000000000002&page=0',
    ]);
  });

  it('stops paging when a page repeats and reads on without nextPageUrl', async () => {
    const page = { spaces: [{ id: '0Zu1', apiName: 'A' }] };
    const fake = fakeConnection({
      ...ENABLED,
      businessUnits: [ENABLED.businessUnits[0]],
      spaces: { '1QO000000000001': [page, { spaces: [{ id: '0Zu2', apiName: 'B' }] }, page] },
    });
    const listing = await readBusinessUnits(fake.connection);
    expect(listing.businessUnits[0].workspaces).to.deep.equal(['A', 'B']);
    expect(fake.requests).to.have.length(3);
  });

  it('uses the fields the describe has', async () => {
    const fake = fakeConnection({
      ...ENABLED,
      businessUnitFields: ['Id', 'DeveloperName', 'Label', 'DataSpaceId'],
      dataSpaceFields: ['Id', 'Name'],
      businessUnits: [{ Id: '1QO000000000001', DeveloperName: 'bu', Label: 'BU label', DataSpaceId: '0vh2' }],
      dataSpaces: [{ Id: '0vh2', Name: 'dataspace2' }],
      spaces: {},
    });
    const listing = await readBusinessUnits(fake.connection);
    expect(fake.queries[0]).to.equal(
      'SELECT Id, DeveloperName, Label, DataSpaceId FROM BusinessUnit ORDER BY DeveloperName'
    );
    expect(fake.queries[1]).to.equal('SELECT Id, Name FROM DataSpace');
    expect(listing.businessUnits[0]).to.include({ label: 'BU label', dataSpace: 'dataspace2' });
    expect(listing.businessUnits[0].workspaces).to.deep.equal([]);
  });

  it('warns about a missing data space and workspaces without an API name', async () => {
    const fake = fakeConnection({
      ...ENABLED,
      businessUnits: [{ Id: '1QO000000000001', DeveloperName: 'bu', MasterLabel: null, DataSpaceId: null }],
      spaces: {
        '1QO000000000001': [
          {
            spaces: [
              { id: '0Zu1', apiName: 'A' },
              { id: '0Zu2', apiName: null },
            ],
            nextPageUrl: null,
          },
        ],
      },
    });
    const listing = await readBusinessUnits(fake.connection);
    expect(listing.businessUnits[0]).to.deep.equal({
      id: '1QO000000000001',
      developerName: 'bu',
      label: 'bu',
      dataSpace: null,
      dataSpaceId: null,
      workspaces: ['A'],
    });
    expect(listing.warnings).to.have.length(2);
    expect(listing.warnings[0]).to.contain('no readable data space');
    expect(listing.warnings[1]).to.contain('without an API name');
  });

  it('never reads the workspace list in an org without the feature', async () => {
    const fake = fakeConnection(DISABLED);
    const listing = await readBusinessUnits(fake.connection);
    expect(listing.businessUnitsEnabled).to.equal(false);
    expect(listing.businessUnits).to.deep.equal([
      {
        id: '1QO000000000009',
        developerName: 'defaultBusinessUnit',
        label: 'default Business Unit',
        dataSpace: 'default',
        dataSpaceId: '0vh1',
        workspaces: null,
      },
    ]);
    expect(listing.warnings).to.have.length(1);
    expect(listing.warnings[0]).to.contain('cannot be listed per business unit');
    expect(fake.requests).to.deep.equal([]);
  });

  it('throws on a spaces answer without a list', async () => {
    const fake = fakeConnection(ENABLED);
    (fake.connection as unknown as { request: () => Promise<unknown> }).request = async () => ({ message: 'no' });
    let message = '';
    try {
      await readBusinessUnits(fake.connection);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).to.contain('has no spaces on page 0');
  });
});

describe('resolveBusinessUnit', () => {
  it('returns the target scope, matching the developer name without case', async () => {
    const result = await resolveBusinessUnit(fakeConnection(ENABLED).connection, 'OTHERbusinessunit');
    expect(result).to.deep.equal({
      ok: true,
      scope: {
        businessUnit: {
          id: '1QO000000000002',
          developerName: 'otherBusinessUnit',
          label: 'Other',
          dataSpace: 'dataspace2',
          dataSpaceId: '0vh2',
          workspaces: ['otherMarketing'],
        },
        dataSpace: 'dataspace2',
        dataSpaceId: '0vh2',
        workspaces: ['otherMarketing'],
      },
    });
  });

  it('reports an unknown business unit with the known ones', async () => {
    const result = await resolveBusinessUnit(fakeConnection(ENABLED).connection, 'nope');
    expect(result).to.deep.equal({
      ok: false,
      code: 'BUSINESS_UNIT_NOT_FOUND',
      message: 'No business unit nope in this org. Business units: defaultBusinessUnit, otherBusinessUnit.',
    });
  });

  it('refuses in an org without the feature and names the plain commands', async () => {
    const result = await resolveBusinessUnit(fakeConnection(DISABLED).connection, 'defaultBusinessUnit');
    expect(result.ok).to.equal(false);
    if (result.ok) return;
    expect(result.code).to.equal('BUSINESS_UNITS_NOT_ENABLED');
    for (const command of ['sf mcnext retrieve', 'sf data360 retrieve --dataspace', 'sf cms retrieve --workspace'])
      expect(result.message).to.contain(command);
  });

  it('returns a failed read instead of throwing', async () => {
    const result = await resolveBusinessUnit(
      fakeConnection({ ...ENABLED, failQuery: 'FROM BusinessUnit' }).connection,
      'otherBusinessUnit'
    );
    expect(result).to.deep.equal({
      ok: false,
      code: 'BUSINESS_UNIT_READ_FAILED',
      message: 'The business units of this org could not be read: INVALID_SESSION_ID',
    });
  });

  it('fails when the business unit has no readable data space', async () => {
    const result = await resolveBusinessUnit(
      fakeConnection({ ...ENABLED, dataSpaces: [ENABLED.dataSpaces[0]] }).connection,
      'otherBusinessUnit'
    );
    expect(result).to.include({ ok: false, code: 'BUSINESS_UNIT_READ_FAILED' });
  });
});

describe('pickWorkspace', () => {
  it('lets --workspace win', () => {
    expect(pickWorkspace(['A', 'B'], 'A', 'Elsewhere')).to.deep.equal({ ok: true, workspace: 'Elsewhere' });
  });

  it('takes the only workspace of the target', () => {
    expect(pickWorkspace(['otherMarketing'], 'Cloud_Kicks')).to.deep.equal({ ok: true, workspace: 'otherMarketing' });
  });

  it('takes the workspace named like the source, in the spelling of the target', () => {
    expect(pickWorkspace(['Cloud_Kicks', 'Default'], 'cloud_kicks')).to.deep.equal({
      ok: true,
      workspace: 'Cloud_Kicks',
    });
  });

  it('asks for --workspace when several exist and none matches', () => {
    const result = pickWorkspace(['A', 'B'], 'Cloud_Kicks');
    expect(result.ok).to.equal(false);
    if (result.ok) return;
    expect(result.code).to.equal('WORKSPACE_REQUIRED');
    expect(result.message).to.contain('A, B').and.to.contain('--workspace').and.to.contain('Cloud_Kicks');
  });

  it('asks for --workspace when the target has none', () => {
    const result = pickWorkspace([], 'Cloud_Kicks');
    expect(result).to.include({ ok: false, code: 'WORKSPACE_REQUIRED' });
    if (!result.ok) expect(result.message).to.contain('--workspace');
  });
});
