import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect } from 'chai';
import { campaignPath, serializeCampaignFile } from '../../src/campaign/file.js';
import type { Item } from '../../src/envelope.js';
import { flowPaths } from '../../src/flow/file.js';
import { cmsExitCodeOf } from '../../src/libraries.js';
import { deploy, type DeployDeps, type DeployOptions } from '../../src/orchestrate/deploy.js';
import { removeTempFolders } from '../flow/support.js';
import { cmsResult, connection, item, NOT_ENABLED, project, SCOPE, type CmsError, type CmsRow } from './support.js';

type CmsCall = Parameters<DeployDeps['cmsDeploy']>[1];
type CampaignCall = Parameters<DeployDeps['deployCampaigns']>[1];
type FlowCall = Parameters<DeployDeps['deployFlows']>[1];

type Calls = { order: string[]; resolved: string[]; cms: CmsCall[]; campaigns: CampaignCall[]; flows: FlowCall[] };

type World = {
  businessUnit?: Awaited<ReturnType<DeployDeps['resolveBusinessUnit']>>;
  cms?: (options: CmsCall) => { items: CmsRow[]; errors?: CmsError[] };
  campaigns?: (options: CampaignCall) => Item[];
  flows?: (options: FlowCall) => Item[];
};

function fakes(world: World = {}): { deps: DeployDeps; calls: Calls } {
  const calls: Calls = { order: [], resolved: [], cms: [], campaigns: [], flows: [] };
  const mode = (preview: boolean | undefined): string => (preview ? 'preview' : 'write');
  return {
    calls,
    deps: {
      resolveBusinessUnit: async (_connection, name) => {
        calls.resolved.push(name);
        return world.businessUnit ?? SCOPE;
      },
      cmsDeploy: async (_connection, options) => {
        calls.order.push(`cms:${options.workspace}:${mode(options.preview)}`);
        calls.cms.push(options);
        const answer = world.cms?.(options) ?? {
          items: [{ type: 'email', apiName: 'Welcome', outcome: options.preview ? 'create' : 'created' }],
        };
        return cmsResult(options.workspace, answer.items, answer.errors);
      },
      deployCampaigns: async (_connection, options) => {
        calls.order.push(`campaigns:${mode(options.preview)}`);
        calls.campaigns.push(options);
        return world.campaigns?.(options) ?? [item('campaign', 'Spring', options.preview ? 'would-create' : 'created')];
      },
      deployFlows: async (_connection, options) => {
        calls.order.push(`flows:${mode(options.preview)}`);
        // The sets are filled before the call; keep what they held at that moment.
        calls.flows.push({
          ...options,
          metInThisRun: {
            content: new Set(options.metInThisRun.content),
            campaigns: new Set(options.metInThisRun.campaigns),
            segments: new Set(options.metInThisRun.segments),
          },
        });
        return world.flows?.(options) ?? [item('flow', 'Welcome_Flow', options.preview ? 'would-create' : 'created')];
      },
      cmsExitCodeOf,
    },
  };
}

const BASE = { preview: false, allowCrossDataspace: false, allowActivation: false };
const ALL = ['email:Welcome', 'campaign:Spring', 'flow:Welcome_Flow'];
const CHECK = ['cms:Default_Content_Workspace:preview', 'campaigns:preview', 'flows:preview'];
const WRITE = ['cms:Default_Content_Workspace:write', 'campaigns:write', 'flows:write'];

async function run(
  options: Partial<DeployOptions>,
  world?: World,
  files = { campaigns: ['Spring'], flows: ['Welcome_Flow'], cms: ['Default_Content_Workspace/email/Welcome'] }
) {
  const projectDir = await project(files);
  const fake = fakes(world);
  const envelope = await deploy(connection, { ...BASE, projectDir, ...options }, fake.deps);
  return { envelope, calls: fake.calls, projectDir };
}

describe('orchestrate deploy', () => {
  after(removeTempFolders);

  describe('refusals before any org access', () => {
    it('refuses a run that names nothing', async () => {
      const { envelope, calls } = await run({});
      expect(envelope).to.include({ status: 1, operation: 'deploy' });
      expect(envelope.errors[0].code).to.equal('NOTHING_SELECTED');
      expect(calls.order).to.deep.equal([]);
    });

    it('refuses the whole run for a Data 360 selector or path', async () => {
      for (const options of [
        { metadata: [...ALL, 'segment:My_Segment'] },
        { metadata: ALL, sourceDirs: ['data360/segments'] },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- two cases
        const { envelope, calls } = await run(options);
        expect(envelope.status).to.equal(1);
        expect(envelope.errors).to.have.length(1);
        expect(envelope.errors[0]).to.include({ code: 'DATA360_WRITE_NOT_AVAILABLE', area: 'data360' });
        expect(envelope.errors[0].message).to.include('sf data360 deploy');
        expect(calls.order).to.deep.equal([]);
        expect(calls.resolved).to.deep.equal([]);
      }
    });

    it('refuses an invalid selector and a path outside the project', async () => {
      const { envelope, calls } = await run({ metadata: [':x'], sourceDirs: ['../elsewhere'] });
      expect(envelope.errors.map((error) => error.code)).to.deep.equal(['INVALID_SELECTOR', 'INVALID_SELECTOR']);
      expect(calls.order).to.deep.equal([]);
    });

    it('refuses a CMS selector that no workspace folder holds, or that several hold', async () => {
      const none = await run({ metadata: ['email:Missing'] });
      expect(none.envelope.errors[0]).to.include({ code: 'WORKSPACE_REQUIRED', area: 'cms' });
      const several = await run({ metadata: ['email:Welcome'] }, undefined, {
        campaigns: [],
        flows: [],
        cms: ['A/email/Welcome', 'B/email/Welcome'],
      });
      expect(several.envelope.errors[0].code).to.equal('WORKSPACE_REQUIRED');
      expect(several.envelope.errors[0].message).to.include('A, B');
      expect([...none.calls.order, ...several.calls.order]).to.deep.equal([]);
    });

    it('refuses a path that does not exist or is no campaign or flow file', async () => {
      const missing = await run({ sourceDirs: ['mcnext/nowhere'] });
      expect(missing.envelope.errors[0].code).to.equal('SOURCE_NOT_FOUND');
      const other = await run({
        sourceDirs: ['cms/Default_Content_Workspace/email/Welcome.email.json', 'mcnext/../mcnext/campaigns'],
      });
      expect(other.envelope.errors).to.deep.equal([]);
    });

    it('refuses --business-unit in an org without business units', async () => {
      const { envelope, calls } = await run(
        { metadata: ALL, businessUnit: 'defaultBusinessUnit' },
        { businessUnit: NOT_ENABLED }
      );
      expect(envelope.status).to.equal(1);
      expect(envelope.errors[0].code).to.equal('BUSINESS_UNITS_NOT_ENABLED');
      expect(calls.order).to.deep.equal([]);
    });
  });

  describe('selection', () => {
    it('finds the workspace of -m in the one folder that holds the component, and of -d in its path', async () => {
      const files = { campaigns: [], flows: [], cms: ['W1/email/Welcome', 'W2/email/Other', 'W2/image/Logo'] };
      const { calls } = await run(
        { metadata: ['email:Welcome'], sourceDirs: ['cms/W2/image', 'cms/W2/email/Other.email.json'], preview: true },
        undefined,
        files
      );
      expect(calls.order).to.deep.equal(['cms:W2:preview', 'cms:W1:preview']);
      expect(calls.cms[0]).to.include({ workspace: 'W2', preview: true }).and.not.have.property('metadata');
      expect(calls.cms[0].sourceDirs).to.deep.equal(['cms/W2/image', 'cms/W2/email/Other.email.json']);
      expect(calls.cms[1].metadata).to.deep.equal(['email:Welcome']);
      expect(calls.cms[1]).to.not.have.property('dataspace');
    });

    it('sends everything to --workspace and splits -d cms into its workspace folders', async () => {
      const files = { campaigns: [], flows: [], cms: ['W1/email/Welcome', 'W2/email/Other'] };
      const explicit = await run(
        { metadata: ['email:Welcome', 'email:Other'], workspace: 'Target', preview: true },
        undefined,
        files
      );
      expect(explicit.calls.order).to.deep.equal(['cms:Target:preview']);
      const whole = await run({ sourceDirs: ['cms'], preview: true }, undefined, files);
      expect(whole.calls.cms.map((call) => call.sourceDirs)).to.deep.equal([['cms/W1'], ['cms/W2']]);
    });

    it('takes campaign and flow files from -m, a bare type and -d', async () => {
      const files = { campaigns: ['Spring', 'Autumn'], flows: ['Welcome_Flow', 'Second_Flow'], cms: [] };
      const named = await run({ metadata: ['campaign:Spring', 'flow:Welcome_Flow'], preview: true }, undefined, files);
      expect(named.calls.campaigns[0].files).to.deep.equal([campaignPath(named.projectDir, 'Spring')]);
      expect(named.calls.flows[0].files).to.deep.equal([flowPaths(named.projectDir, 'Welcome_Flow').xml]);
      expect(named.calls.order).to.deep.equal(['campaigns:preview', 'flows:preview']);

      const bare = await run({ metadata: ['campaign', 'flow'], preview: true }, undefined, files);
      expect(bare.calls.campaigns[0].files).to.have.length(2);
      expect(bare.calls.flows[0].files).to.have.length(2);

      const folder = await run({ sourceDirs: ['mcnext'], preview: true }, undefined, files);
      expect(folder.calls.campaigns[0].files).to.have.length(2);
      expect(folder.calls.flows[0].files).to.have.length(2);
    });
  });

  describe('campaigns of business units', () => {
    async function withUnitFile(projectDir: string, name: string, businessUnit: string): Promise<string> {
      const path = campaignPath(projectDir, name, businessUnit);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        serializeCampaignFile({ name, fields: {}, businessUnit: { developerName: businessUnit } }),
        'utf8'
      );
      return path;
    }

    async function runWith(options: Partial<DeployOptions>, world: World) {
      const projectDir = await project({ campaigns: ['Spring', 'Autumn'], flows: ['Welcome_Flow'] });
      const inUnit = await withUnitFile(projectDir, 'Spring', 'otherBusinessUnit');
      const fake = fakes(world);
      const envelope = await deploy(connection, { ...BASE, projectDir, preview: true, ...options }, fake.deps);
      return { envelope, calls: fake.calls, projectDir, inUnit };
    }

    const previews = (options: CampaignCall): Item[] =>
      options.files.map((path) =>
        item('campaign', path.includes('Autumn') ? 'Autumn' : 'Spring', 'would-create', { path })
      );

    it('selects every file named after -m campaign:Name, flat and in the business unit folders', async () => {
      const { calls, projectDir, inUnit } = await runWith({ metadata: ['campaign:Spring'] }, { campaigns: previews });
      expect(calls.campaigns[0].files).to.deep.equal([campaignPath(projectDir, 'Spring'), inUnit]);
      // A name without a file is handed on as the file it would have, and reported by the campaign service.
      const missing = await runWith({ metadata: ['campaign:Winter'] }, { campaigns: previews });
      expect(missing.calls.campaigns[0].files).to.deep.equal([campaignPath(missing.projectDir, 'Winter')]);
    });

    it('finds the files of a bare campaign and of -d in the flat folder and the business unit folders', async () => {
      const bare = await runWith({ metadata: ['campaign'] }, { campaigns: previews });
      expect(bare.calls.campaigns[0].files).to.have.members([
        campaignPath(bare.projectDir, 'Spring'),
        campaignPath(bare.projectDir, 'Autumn'),
        bare.inUnit,
      ]);
      const folder = await runWith({ sourceDirs: ['mcnext/campaigns/otherBusinessUnit'] }, { campaigns: previews });
      expect(folder.calls.campaigns[0].files).to.deep.equal([folder.inUnit]);
    });

    it('names the campaigns of this run to the flows by business unit and name', async () => {
      const own = await runWith({ metadata: ['campaign', 'flow'] }, { campaigns: previews });
      expect([...own.calls.flows[0].metInThisRun.campaigns]).to.have.members([
        '/Spring',
        '/Autumn',
        'otherbusinessunit/Spring',
      ]);
      // A copy puts every campaign of the run into the target business unit.
      const copied = await runWith(
        { metadata: ['campaign:Autumn', 'flow'], businessUnit: 'otherBusinessUnit' },
        { campaigns: previews }
      );
      expect([...copied.calls.flows[0].metInThisRun.campaigns]).to.deep.equal(['otherbusinessunit/Autumn']);
    });
  });

  describe('preview', () => {
    it('checks every area and writes nothing', async () => {
      const { envelope, calls } = await run({ metadata: ALL, preview: true });
      expect(calls.order).to.deep.equal(CHECK);
      expect(envelope).to.include({ status: 0, preview: true });
      expect(envelope.items.map((row) => `${row.area}/${row.type}/${row.outcome}`)).to.deep.equal([
        'cms/email/would-create',
        'mcnext/campaign/would-create',
        'mcnext/flow/would-create',
      ]);
      expect(envelope.areas.cms).to.be.an('array').with.length(1);
    });

    it('counts what the same run creates as met for the flows', async () => {
      const { calls } = await run(
        { metadata: [...ALL, 'email:Broken'], preview: true },
        {
          cms: () => ({
            items: [
              { type: 'email', apiName: 'Welcome', outcome: 'planned-dependencies', action: 'create' },
              { type: 'email', apiName: 'Broken', outcome: 'blocked', reason: 'REFERENCE_NOT_FOUND' },
            ],
          }),
          campaigns: () => [item('campaign', 'Spring', 'would-create'), item('campaign', 'Twice', 'blocked')],
        },
        {
          campaigns: ['Spring'],
          flows: ['Welcome_Flow'],
          cms: ['Default_Content_Workspace/email/Welcome', 'Default_Content_Workspace/email/Broken'],
        }
      );
      const met = calls.flows[0].metInThisRun;
      expect([...met.content]).to.deep.equal(['Default_Content_Workspace/email/Welcome']);
      expect([...met.campaigns]).to.deep.equal(['/Spring']);
      expect([...met.segments]).to.deep.equal([]);
    });
  });

  describe('real run', () => {
    it('checks first, then writes CMS content, campaigns and flows in that order', async () => {
      const { envelope, calls } = await run({ metadata: ALL, allowActivation: true });
      expect(calls.order).to.deep.equal([...CHECK, ...WRITE]);
      expect(calls.flows.map((call) => call.allowActivation)).to.deep.equal([true, true]);
      expect(calls.flows[1]).to.not.have.property('target');
      expect(calls.campaigns[1]).to.not.have.property('targetBusinessUnit');
      expect(envelope).to.include({ status: 0, preview: false });
      expect(envelope.items.map((row) => row.outcome)).to.deep.equal(['created', 'created', 'created']);
      expect(envelope.warnings).to.deep.equal([]);
    });

    it('writes nothing when the check finds a blocked component', async () => {
      const { envelope, calls } = await run(
        { metadata: ALL },
        { flows: () => [item('flow', 'Welcome_Flow', 'blocked', { code: 'SEGMENT_NOT_FOUND' })] }
      );
      expect(calls.order).to.deep.equal(CHECK);
      expect(envelope.status).to.equal(1);
      expect(envelope.preview).to.equal(false);
      expect(envelope.warnings[0]).to.include('Nothing was written');
      expect(envelope.items.map((row) => row.outcome)).to.deep.equal(['would-create', 'would-create', 'blocked']);
    });

    it('writes nothing when the CMS check fails as a whole', async () => {
      const { envelope, calls } = await run(
        { metadata: ALL },
        { cms: () => ({ items: [], errors: [{ code: 'WORKSPACE_NOT_FOUND', message: 'No such workspace' }] }) }
      );
      expect(calls.order).to.deep.equal(CHECK);
      expect(envelope.status).to.equal(1);
      expect(envelope.errors[0]).to.deep.equal({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'No such workspace',
        area: 'cms',
      });
    });

    it('stops at the first failed area and marks the rest not-attempted (status 1)', async () => {
      const { envelope, calls } = await run(
        { metadata: ALL },
        {
          cms: (options) =>
            options.preview
              ? { items: [{ type: 'email', apiName: 'Welcome', outcome: 'create' }] }
              : {
                  items: [{ type: 'email', apiName: 'Welcome', outcome: 'failed', reason: 'CREATE_FAILED' }],
                  errors: [{ code: 'CREATE_FAILED', message: 'Salesforce said no', component: 'email:Welcome' }],
                },
        }
      );
      expect(calls.order).to.deep.equal([...CHECK, 'cms:Default_Content_Workspace:write']);
      expect(envelope.items.map((row) => `${row.type}/${row.outcome}`)).to.deep.equal([
        'email/failed',
        'campaign/not-attempted',
        'flow/not-attempted',
      ]);
      expect(envelope.items[0]).to.include({ code: 'CREATE_FAILED', message: 'Salesforce said no' });
      expect(envelope.status).to.equal(1);
    });

    it('is 68 when something was written before the failure', async () => {
      const { envelope, calls } = await run(
        { metadata: ALL },
        {
          campaigns: (options) => [
            item('campaign', 'Spring', options.preview ? 'would-create' : 'unknown', {
              code: 'CAMPAIGN_WRITE_UNKNOWN',
            }),
          ],
        }
      );
      expect(calls.order).to.deep.equal([...CHECK, 'cms:Default_Content_Workspace:write', 'campaigns:write']);
      expect(envelope.items.map((row) => row.outcome)).to.deep.equal(['created', 'unknown', 'not-attempted']);
      expect(envelope.status).to.equal(68);
    });

    it('is 68 when a flow is deployed and its campaign link failed', async () => {
      const { envelope } = await run(
        { metadata: ['flow:Welcome_Flow'] },
        {
          flows: (options) =>
            options.preview
              ? [item('flow', 'Welcome_Flow', 'would-create')]
              : [
                  item('flow', 'Welcome_Flow', 'created'),
                  item('campaign-link', 'Welcome_Flow', 'failed', { code: 'CAMPAIGN_LINK_FAILED' }),
                ],
        }
      );
      expect(envelope.status).to.equal(68);
    });

    it('is 69 when nothing failed and Salesforce is still working on the content', async () => {
      const { envelope, calls } = await run(
        { metadata: ['email:Welcome', 'campaign:Spring'] },
        {
          cms: (options) =>
            options.preview
              ? { items: [{ type: 'email', apiName: 'Welcome', outcome: 'update' }] }
              : {
                  items: [{ type: 'email', apiName: 'Welcome', outcome: 'updated' }],
                  errors: [{ code: 'STATE_NOT_CONFIRMED', message: 'not read back yet' }],
                },
        }
      );
      // An open outcome stops the run: a campaign is not written on top of it.
      expect(calls.order).to.deep.equal([
        'cms:Default_Content_Workspace:preview',
        'campaigns:preview',
        'cms:Default_Content_Workspace:write',
      ]);
      expect(envelope.items.map((row) => row.outcome)).to.deep.equal(['updated', 'not-attempted']);
      expect(envelope.status).to.equal(69);
    });
  });

  describe('target', () => {
    it('copies into a business unit: workspace, data space and business unit of the target', async () => {
      const { envelope, calls } = await run({
        metadata: ALL,
        businessUnit: 'otherBusinessUnit',
        allowCrossDataspace: true,
      });
      expect(calls.resolved).to.deep.equal(['otherBusinessUnit']);
      expect(calls.order).to.deep.equal([
        'cms:otherMarketing:preview',
        'campaigns:preview',
        'flows:preview',
        'cms:otherMarketing:write',
        'campaigns:write',
        'flows:write',
      ]);
      expect(calls.cms[1]).to.include({
        workspace: 'otherMarketing',
        dataspace: 'dataspace2',
        allowCrossDataspace: true,
        preview: false,
      });
      expect(calls.campaigns[1].targetBusinessUnit).to.deep.equal({
        id: '1QO000000000002AAA',
        developerName: 'otherBusinessUnit',
      });
      const target = calls.flows[1].target;
      expect(target?.dataSpace).to.equal('dataspace2');
      expect(target?.workspaceFor('Default_Content_Workspace')).to.equal('otherMarketing');
      // The flows name their content in the target workspace.
      expect([...calls.flows[0].metInThisRun.content]).to.deep.equal(['otherMarketing/email/Welcome']);
      expect(envelope.status).to.equal(0);
    });

    it('stops when the target business unit has several workspaces and none is named like the source', async () => {
      const several = {
        ...SCOPE,
        scope: { ...(SCOPE as { scope: object }).scope, workspaces: ['A', 'B'] },
      } as typeof SCOPE;
      const refused = await run({ metadata: ALL, businessUnit: 'otherBusinessUnit' }, { businessUnit: several });
      expect(refused.envelope.errors[0]).to.include({ code: 'WORKSPACE_REQUIRED', area: 'cms' });
      expect(refused.calls.order).to.deep.equal([]);

      const chosen = await run(
        { metadata: ALL, businessUnit: 'otherBusinessUnit', workspace: 'B', preview: true },
        { businessUnit: several }
      );
      expect(chosen.calls.cms[0].workspace).to.equal('B');
      expect(chosen.calls.flows[0].target?.workspaceFor('anything')).to.equal('B');
    });

    it('uses --workspace and --dataspace alone as the target of content and flows', async () => {
      const workspace = await run({ metadata: ALL, workspace: 'Other_Workspace', preview: true });
      expect(workspace.calls.resolved).to.deep.equal([]);
      expect(workspace.calls.cms[0].workspace).to.equal('Other_Workspace');
      expect(workspace.calls.cms[0]).to.not.have.property('dataspace');
      expect(workspace.calls.flows[0].target?.dataSpace).to.equal(undefined);
      expect(workspace.calls.flows[0].target?.workspaceFor('Default_Content_Workspace')).to.equal('Other_Workspace');

      const dataspace = await run({ metadata: ALL, dataspace: 'dataspace2', preview: true });
      expect(dataspace.calls.cms[0]).to.include({ workspace: 'Default_Content_Workspace', dataspace: 'dataspace2' });
      expect(dataspace.calls.flows[0].target?.dataSpace).to.equal('dataspace2');
      expect(dataspace.calls.flows[0].target?.workspaceFor('Default_Content_Workspace')).to.equal(
        'Default_Content_Workspace'
      );
    });
  });
});
