import { expect } from 'chai';
import { cmsExitCodeOf, data360ExitCodeOf } from '../../src/libraries.js';
import { retrieve, type RetrieveDeps, type RetrieveOptions } from '../../src/orchestrate/retrieve.js';
import type { Item } from '../../src/envelope.js';
import { cmsResult, connection, data360Result, item, NOT_ENABLED, ORG_ID, SCOPE } from './support.js';

type Calls = {
  order: string[];
  resolved: string[];
  campaigns: Array<Parameters<RetrieveDeps['retrieveCampaigns']>[1]>;
  flows: Array<Parameters<RetrieveDeps['retrieveFlows']>[1]>;
  data360: Array<Parameters<RetrieveDeps['runRetrieve']>[1]>;
  cms: Array<Parameters<RetrieveDeps['cmsRetrieve']>[1]>;
};

type World = {
  businessUnit?: Awaited<ReturnType<RetrieveDeps['resolveBusinessUnit']>>;
  campaigns?: Item[];
  flows?: Item[];
  data360?: () => ReturnType<RetrieveDeps['runRetrieve']>;
  cms?: (workspace: string) => Awaited<ReturnType<RetrieveDeps['cmsRetrieve']>>;
};

function fakes(world: World = {}): { deps: RetrieveDeps; calls: Calls } {
  const calls: Calls = { order: [], resolved: [], campaigns: [], flows: [], data360: [], cms: [] };
  return {
    calls,
    deps: {
      resolveBusinessUnit: async (_connection, name) => {
        calls.resolved.push(name);
        return world.businessUnit ?? SCOPE;
      },
      retrieveCampaigns: async (_connection, options) => {
        calls.order.push('campaigns');
        calls.campaigns.push(options);
        return world.campaigns ?? [item('campaign', 'Spring', 'retrieved')];
      },
      retrieveFlows: async (_connection, options) => {
        calls.order.push('flows');
        calls.flows.push(options);
        return world.flows ?? [item('flow', 'Welcome_Flow', 'retrieved')];
      },
      runRetrieve: async (_connection, options) => {
        calls.order.push('data360');
        calls.data360.push(options);
        return world.data360
          ? world.data360()
          : data360Result('success', [{ family: 'segment', apiName: 'My_Segment' }, { apiName: 'Thing__dlm' }]);
      },
      cmsRetrieve: async (_connection, options) => {
        calls.order.push(`cms:${options.workspace}`);
        calls.cms.push(options);
        return world.cms
          ? world.cms(options.workspace)
          : cmsResult(options.workspace, [
              { type: 'email', apiName: 'Welcome', outcome: 'retrieved', path: 'cms/x/email/Welcome.email.json' },
            ]);
      },
      data360ExitCodeOf,
      cmsExitCodeOf,
    },
  };
}

const OUT = 'project';
const run = (options: Partial<RetrieveOptions>, world?: World) => {
  const fake = fakes(world);
  return retrieve(connection, { outputDir: OUT, ...options }, fake.deps).then((envelope) => ({
    envelope,
    calls: fake.calls,
  }));
};

describe('orchestrate retrieve', () => {
  it('retrieves every campaign and every marketing flow without -m and without a business unit', async () => {
    const { envelope, calls } = await run({});
    expect(calls.order).to.deep.equal(['campaigns', 'flows']);
    expect(calls.campaigns[0]).to.deep.equal({ outputDir: OUT });
    expect(calls.flows[0]).to.deep.equal({ outputDir: OUT });
    expect(envelope).to.include({ status: 0, operation: 'retrieve', preview: false, orgId: ORG_ID });
    expect(envelope.items.map((row) => row.outcome)).to.deep.equal(['retrieved', 'retrieved']);
    expect(envelope.areas).to.deep.equal({});
  });

  it('refuses an invalid selector before anything is read', async () => {
    const { envelope, calls } = await run({ metadata: ['campaign:'] });
    expect(envelope.status).to.equal(1);
    expect(envelope.errors[0].code).to.equal('INVALID_SELECTOR');
    expect(calls.order).to.deep.equal([]);
  });

  it('needs --workspace for a CMS selector without a business unit', async () => {
    const { envelope, calls } = await run({ metadata: ['email:Welcome', 'campaign:Spring'] });
    expect(envelope.status).to.equal(1);
    expect(envelope.errors[0]).to.include({ code: 'WORKSPACE_REQUIRED', area: 'cms' });
    expect(calls.order).to.deep.equal([]);
    expect(calls.resolved).to.deep.equal([]);
  });

  it('routes -m selectors by area, one area after the other', async () => {
    const { envelope, calls } = await run({
      metadata: [
        'campaign:Spring',
        'campaign:Autumn',
        'flow',
        'flow:Welcome_Flow',
        'segment:My_Segment',
        'dmo',
        'email:Welcome',
      ],
      workspace: 'Default_Content_Workspace',
    });
    expect(calls.order).to.deep.equal(['data360', 'cms:Default_Content_Workspace', 'campaigns', 'flows']);
    // The data plugin always replaces differing files; there is no overwrite option.
    expect(calls.data360[0]).to.deep.equal({
      dataspace: 'default',
      metadata: ['segment:My_Segment', 'dmo'],
      outputDir: OUT,
    });
    expect(calls.cms[0]).to.deep.equal({
      workspace: 'Default_Content_Workspace',
      metadata: ['email:Welcome'],
      outputDirectory: OUT,
    });
    expect(calls.campaigns[0]).to.deep.equal({ names: ['Spring', 'Autumn'], outputDir: OUT });
    // A bare type wins over a named one: every flow.
    expect(calls.flows[0]).to.deep.equal({ outputDir: OUT });
    expect(envelope.status).to.equal(0);
    expect(envelope.items.map((row) => `${row.area}/${row.type}/${row.name}/${row.outcome}`)).to.deep.equal([
      'data360/segment/My_Segment/retrieved',
      'data360/dmo/Thing__dlm/retrieved',
      'cms/email/Welcome/retrieved',
      'mcnext/campaign/Spring/retrieved',
      'mcnext/flow/Welcome_Flow/retrieved',
    ]);
  });

  it('uses --dataspace for Data 360 selectors and runs only the selected areas', async () => {
    const { calls } = await run({ metadata: ['segment'], dataspace: 'dataspace2' });
    expect(calls.order).to.deep.equal(['data360']);
    expect(calls.data360[0]).to.include({ dataspace: 'dataspace2' });
  });

  it('keeps flows to --dataspace when no business unit is given', async () => {
    const { calls } = await run({ metadata: ['flow'], dataspace: 'dataspace2' });
    expect(calls.flows[0]).to.deep.equal({ dataSpace: 'dataspace2', outputDir: OUT });
  });

  it('retrieves the scopes of a business unit', async () => {
    const twoWorkspaces = {
      ...SCOPE,
      scope: { ...(SCOPE as { scope: object }).scope, workspaces: ['Cloud_Kicks', 'Default_Content_Workspace'] },
    } as typeof SCOPE;
    const { envelope, calls } = await run({ businessUnit: 'otherBusinessUnit' }, { businessUnit: twoWorkspaces });
    expect(calls.resolved).to.deep.equal(['otherBusinessUnit']);
    expect(calls.order).to.deep.equal([
      'data360',
      'cms:Cloud_Kicks',
      'cms:Default_Content_Workspace',
      'campaigns',
      'flows',
    ]);
    // Every family of the data space, files replaced.
    expect(calls.data360[0]).to.deep.equal({ dataspace: 'dataspace2', outputDir: OUT });
    expect(calls.cms.map((options) => options.metadata)).to.deep.equal([undefined, undefined]);
    expect(calls.campaigns[0]).to.deep.equal({ businessUnitId: '1QO000000000002AAA', outputDir: OUT });
    expect(calls.flows[0]).to.deep.equal({
      dataSpace: 'dataspace2',
      dataSpaceId: '0vh000000000002AAA',
      outputDir: OUT,
    });
    expect(envelope.status).to.equal(0);
    // The two libraries' envelopes are passed on unchanged.
    expect(envelope.areas.data360).to.have.nested.property('result.items').with.length(2);
    expect(envelope.areas.cms).to.be.an('array').with.length(2);
    expect(envelope.areas.cms).to.have.nested.property('[0].result.workspace.apiName', 'Cloud_Kicks');
  });

  it('refuses --business-unit in an org without business units and reads nothing else', async () => {
    const { envelope, calls } = await run({ businessUnit: 'defaultBusinessUnit' }, { businessUnit: NOT_ENABLED });
    expect(envelope.status).to.equal(1);
    expect(envelope.errors).to.deep.equal([
      { code: 'BUSINESS_UNITS_NOT_ENABLED', message: (NOT_ENABLED as { message: string }).message },
    ]);
    expect(calls.order).to.deep.equal([]);
  });

  describe('status', () => {
    it('is 68 when the Data 360 retrieve is partial', async () => {
      const { envelope } = await run(
        { metadata: ['dlo'] },
        {
          data360: async () =>
            data360Result(
              'partial',
              [{ family: 'dlo', apiName: 'A__dll' }],
              [{ code: 'DLO_READ_FAILED', message: 'no' }]
            ),
        }
      );
      expect(envelope.status).to.equal(68);
      expect(envelope.errors[0]).to.deep.equal({ code: 'DLO_READ_FAILED', message: 'no', area: 'data360' });
    });

    it('is 1 when nothing was retrieved and something failed', async () => {
      const { envelope } = await run(
        { metadata: ['flow:Nope'] },
        { flows: [item('flow', 'Nope', 'failed', { code: 'FLOW_NOT_FOUND' })] }
      );
      expect(envelope.status).to.equal(1);
    });

    it('is 68 when one area failed as a whole and another retrieved', async () => {
      const { envelope } = await run(
        { metadata: ['email', 'campaign'], workspace: 'Nope' },
        {
          cms: (workspace) => cmsResult(workspace, [], [{ code: 'WORKSPACE_NOT_FOUND', message: 'No workspace Nope' }]),
        }
      );
      expect(envelope.status).to.equal(68);
      expect(envelope.errors[0]).to.deep.equal({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'No workspace Nope',
        area: 'cms',
      });
    });

    it('reports a Data 360 retrieve that throws and still runs the other areas', async () => {
      const { envelope, calls } = await run(
        { metadata: ['dmo', 'campaign'] },
        {
          data360: async () => {
            throw Object.assign(new Error('session expired'), { code: 'AUTHENTICATION_FAILED' });
          },
        }
      );
      expect(calls.order).to.deep.equal(['data360', 'campaigns']);
      expect(envelope.errors[0]).to.deep.equal({
        code: 'AUTHENTICATION_FAILED',
        message: 'session expired',
        area: 'data360',
      });
      expect(envelope.status).to.equal(68);
    });
  });
});
