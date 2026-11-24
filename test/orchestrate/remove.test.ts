import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import { campaignPath, serializeCampaignFile } from '../../src/campaign/file.js';
import type { Item } from '../../src/envelope.js';
import { flowPaths } from '../../src/flow/file.js';
import { cmsExitCodeOf } from '../../src/libraries.js';
import { remove, type RemoveDeps, type RemoveOptions } from '../../src/orchestrate/remove.js';
import { removeTempFolders } from '../flow/support.js';
import { cmsResult, connection, item, project, type CmsError, type CmsRow } from './support.js';

type FlowCall = Parameters<RemoveDeps['removeFlows']>[1];
type CampaignCall = Parameters<RemoveDeps['removeCampaigns']>[1];
type CmsCall = Parameters<RemoveDeps['cmsRemove']>[1];
type Calls = { order: string[]; flows: FlowCall[]; campaigns: CampaignCall[]; cms: CmsCall[] };

type World = {
  flows?: (options: FlowCall) => Item[];
  campaigns?: (options: CampaignCall) => Item[];
  cms?: (options: CmsCall) => { items: CmsRow[]; errors?: CmsError[] };
};

function fakes(world: World = {}): { deps: RemoveDeps; calls: Calls } {
  const calls: Calls = { order: [], flows: [], campaigns: [], cms: [] };
  const mode = (preview: boolean | undefined): string => (preview ? 'preview' : 'write');
  return {
    calls,
    deps: {
      removeFlows: async (_connection, options) => {
        calls.order.push(`flows:${mode(options.preview)}`);
        calls.flows.push(options);
        return (
          world.flows?.(options) ??
          options.flows.map(({ name }) => item('flow', name, options.preview ? 'would-delete' : 'deleted'))
        );
      },
      removeCampaigns: async (_connection, options) => {
        calls.order.push(`campaigns:${mode(options.preview)}`);
        calls.campaigns.push(options);
        return (
          world.campaigns?.(options) ??
          options.campaigns.map(({ name }) => item('campaign', name, options.preview ? 'would-delete' : 'deleted'))
        );
      },
      cmsRemove: async (_connection, options) => {
        calls.order.push(`cms:${options.workspace}:${mode(options.preview)}`);
        calls.cms.push(options);
        const answer = world.cms?.(options) ?? {
          items: [{ type: 'email', apiName: 'Welcome', outcome: options.preview ? 'delete' : 'deleted' }],
        };
        return cmsResult(options.workspace, answer.items, answer.errors);
      },
      cmsExitCodeOf,
    },
  };
}

const BASE = { preview: false, confirmDelete: true, keepLocalFiles: false };
const ALL = ['flow:Welcome_Flow', 'campaign:Spring', 'email:Welcome'];
const CHECK = ['flows:preview', 'campaigns:preview', 'cms:Default_Content_Workspace:preview'];
const WRITE = ['flows:write', 'campaigns:write', 'cms:Default_Content_Workspace:write'];

async function run(options: Partial<RemoveOptions>, world?: World) {
  const projectDir = await project({
    campaigns: ['Spring', 'Summer Sale'],
    flows: ['Welcome_Flow'],
    cms: ['Default_Content_Workspace/email/Welcome'],
  });
  const fake = fakes(world);
  const envelope = await remove(connection, { ...BASE, projectDir, ...options }, fake.deps);
  return { envelope, calls: fake.calls, projectDir };
}

describe('orchestrate delete', () => {
  after(removeTempFolders);

  it('needs --confirm-delete or --preview before anything is read', async () => {
    const { envelope, calls } = await run({ metadata: ALL, confirmDelete: false });
    expect(envelope).to.include({ status: 1, operation: 'delete' });
    expect(envelope.errors[0].code).to.equal('CONFIRM_DELETE_REQUIRED');
    expect(calls.order).to.deep.equal([]);
  });

  it('refuses the whole run for a Data 360 selector', async () => {
    const { envelope, calls } = await run({ metadata: [...ALL, 'dmo:Thing__dlm'] });
    expect(envelope.status).to.equal(1);
    expect(envelope.errors[0]).to.include({ code: 'DATA360_WRITE_NOT_AVAILABLE', area: 'data360' });
    expect(envelope.errors[0].message).to.include('sf data360 delete');
    expect(calls.order).to.deep.equal([]);
  });

  it('refuses a run that names nothing, and a CMS selector without a clear workspace', async () => {
    const nothing = await run({});
    expect(nothing.envelope.errors[0].code).to.equal('NOTHING_SELECTED');
    const unclear = await run({ metadata: ['email:Missing'] });
    expect(unclear.envelope.errors[0].code).to.equal('WORKSPACE_REQUIRED');
    expect([...nothing.calls.order, ...unclear.calls.order]).to.deep.equal([]);
  });

  it('previews without --confirm-delete and deletes nothing', async () => {
    const { envelope, calls } = await run({ metadata: ALL, preview: true, confirmDelete: false });
    expect(calls.order).to.deep.equal(CHECK);
    expect(envelope).to.include({ status: 0, preview: true });
    expect(envelope.items.map((row) => `${row.area}/${row.type}/${row.outcome}`)).to.deep.equal([
      'mcnext/flow/would-delete',
      'mcnext/campaign/would-delete',
      'cms/email/would-delete',
    ]);
  });

  it('checks first, then deletes flows, campaigns and CMS content in that order', async () => {
    const { envelope, calls, projectDir } = await run({ metadata: ALL, keepLocalFiles: true });
    expect(calls.order).to.deep.equal([...CHECK, ...WRITE]);
    // -m flow:X is the flow's own file; -m campaign:Name has no file, so the service derives it.
    expect(calls.flows[1]).to.deep.equal({
      flows: [{ name: 'Welcome_Flow', path: flowPaths(projectDir, 'Welcome_Flow').xml }],
      preview: false,
      projectDir,
      keepLocalFiles: true,
    });
    expect(calls.campaigns[1]).to.deep.equal({
      campaigns: [{ name: 'Spring' }],
      preview: false,
      projectDir,
      keepLocalFiles: true,
    });
    expect(calls.cms[1]).to.deep.equal({
      workspace: 'Default_Content_Workspace',
      metadata: ['email:Welcome'],
      projectDirectory: projectDir,
      preview: false,
      keepLocalFiles: true,
    });
    expect(envelope.status).to.equal(0);
    expect(envelope.items.map((row) => row.outcome)).to.deep.equal(['deleted', 'deleted', 'deleted']);
  });

  it('reads the campaign name from the file for -d and a bare type', async () => {
    const { calls, projectDir } = await run({
      metadata: ['campaign'],
      sourceDirs: ['mcnext/flows'],
      workspace: 'Other',
      preview: true,
    });
    expect(calls.campaigns[0].campaigns).to.have.deep.members([
      { name: 'Spring', path: campaignPath(projectDir, 'Spring') },
      { name: 'Summer Sale', path: campaignPath(projectDir, 'Summer Sale') },
    ]);
    expect(calls.flows[0].flows).to.deep.equal([
      { name: 'Welcome_Flow', path: flowPaths(projectDir, 'Welcome_Flow').xml },
    ]);
    expect(calls.order).to.deep.equal(['flows:preview', 'campaigns:preview']);
  });

  it('hands over the file a campaign was selected from, under the name inside it', async () => {
    const projectDir = await project({ campaigns: ['Spring'] });
    // The file is named after one campaign and holds another.
    const file = join(projectDir, 'mcnext', 'campaigns', 'A.campaign.json');
    await writeFile(file, serializeCampaignFile({ name: 'Spring', fields: {} }), 'utf8');
    const fake = fakes();
    await remove(
      connection,
      { ...BASE, projectDir, sourceDirs: ['mcnext/campaigns/A.campaign.json'], preview: true },
      fake.deps
    );
    expect(fake.calls.campaigns[0].campaigns).to.deep.equal([{ name: 'Spring', path: file }]);
  });

  it('deletes nothing when the check finds a blocked component', async () => {
    const { envelope, calls } = await run(
      { metadata: ALL },
      { campaigns: () => [item('campaign', 'Spring', 'blocked', { code: 'CAMPAIGN_NAME_AMBIGUOUS' })] }
    );
    expect(calls.order).to.deep.equal(CHECK);
    expect(envelope.status).to.equal(1);
    expect(envelope.warnings[0]).to.include('Nothing was deleted');
  });

  it('stops at the first failed area and marks the rest not-attempted', async () => {
    const failed = await run(
      { metadata: ALL },
      {
        flows: (options) => [
          item('flow', 'Welcome_Flow', options.preview ? 'would-delete' : 'failed', { code: 'FLOW_DELETE_FAILED' }),
        ],
      }
    );
    expect(failed.calls.order).to.deep.equal([...CHECK, 'flows:write']);
    expect(failed.envelope.items.map((row) => `${row.type}/${row.outcome}`)).to.deep.equal([
      'flow/failed',
      'campaign/not-attempted',
      'email/not-attempted',
    ]);
    expect(failed.envelope.status).to.equal(1);

    const partial = await run(
      { metadata: ALL },
      {
        campaigns: (options) => [
          item('campaign', 'Spring', options.preview ? 'would-delete' : 'unknown', { code: 'CAMPAIGN_WRITE_UNKNOWN' }),
        ],
      }
    );
    expect(partial.calls.order).to.deep.equal([...CHECK, 'flows:write', 'campaigns:write']);
    expect(partial.envelope.items.map((row) => row.outcome)).to.deep.equal(['deleted', 'unknown', 'not-attempted']);
    expect(partial.envelope.status).to.equal(68);
  });

  it('is 68 when CMS deleted one component and failed on another', async () => {
    const { envelope } = await run(
      { metadata: ['email:Welcome'] },
      {
        cms: (options) =>
          options.preview
            ? {
                items: [
                  { type: 'email', apiName: 'Welcome', outcome: 'delete' },
                  { type: 'email', apiName: 'Other', outcome: 'delete' },
                ],
              }
            : {
                items: [
                  { type: 'email', apiName: 'Welcome', outcome: 'deleted' },
                  { type: 'email', apiName: 'Other', outcome: 'failed', reason: 'DELETE_FAILED' },
                ],
                errors: [{ code: 'DELETE_FAILED', message: 'in use', component: 'email:Other' }],
              },
      }
    );
    expect(envelope.status).to.equal(68);
    expect(envelope.items[1]).to.include({ outcome: 'failed', code: 'DELETE_FAILED', message: 'in use' });
  });
});
