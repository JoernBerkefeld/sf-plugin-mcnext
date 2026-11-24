import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Connection } from '@salesforce/core';
import type { ResolvedBusinessUnit } from '../../src/business-units.js';
import { campaignPath, serializeCampaignFile } from '../../src/campaign/file.js';
import type { Item, Outcome } from '../../src/envelope.js';
import { flowPaths } from '../../src/flow/file.js';
import type { CmsResult, Data360RetrieveEnvelope } from '../../src/libraries.js';
import { FLOW_FILE, tempFolder } from '../flow/support.js';

export const ORG_ID = '00D000000000001AAA';

export const connection = { getAuthInfoFields: () => ({ orgId: ORG_ID }) } as unknown as Connection;

export type CmsRow = {
  type: string;
  apiName: string;
  outcome: string;
  reason?: string;
  action?: string;
  path?: string;
};
export type CmsError = { code: string; message: string; component?: string };

/** An envelope as `sf-plugin-cms` returns it. */
export function cmsResult<R>(workspace: string, items: CmsRow[], errors: CmsError[] = []): CmsResult<R> {
  return {
    status: errors.length === 0 ? 'success' : 'failed',
    metadata: { command: 'test', apiVersion: '68.0' },
    diagnostics: { warnings: [], errors },
    result: { workspace: { id: '0Zu000000000001', apiName: workspace }, items },
  } as unknown as CmsResult<R>;
}

/** An envelope as `sf data360 retrieve` returns it. */
export function data360Result(
  status: Data360RetrieveEnvelope['status'],
  names: Array<{ family?: string; apiName: string }>,
  errors: Array<{ code: string; message: string }> = []
): Data360RetrieveEnvelope {
  return {
    status,
    diagnostics: { warnings: [], errors },
    result: {
      scope: { dataSpace: 'default', outputDir: '.' },
      selection: [],
      items: names.map(({ family, apiName }) => ({
        identity: { dataSpace: 'default', apiName },
        operation: 'retrieve',
        outcome: 'retrieved',
        path: join('data360', family ?? 'dmo', `${apiName}.json`),
        ...(family ? { family } : {}),
      })),
    },
  } as unknown as Data360RetrieveEnvelope;
}

export function item(type: string, name: string, outcome: Outcome, more: Partial<Item> = {}): Item {
  return { area: 'mcnext', type, name, outcome, ...more };
}

export const SCOPE: ResolvedBusinessUnit = {
  ok: true,
  scope: {
    businessUnit: {
      id: '1QO000000000002AAA',
      developerName: 'otherBusinessUnit',
      label: 'Other',
      dataSpace: 'dataspace2',
      dataSpaceId: '0vh000000000002AAA',
      workspaces: ['otherMarketing'],
    },
    dataSpace: 'dataspace2',
    dataSpaceId: '0vh000000000002AAA',
    workspaces: ['otherMarketing'],
  },
};

export const NOT_ENABLED: ResolvedBusinessUnit = {
  ok: false,
  code: 'BUSINESS_UNITS_NOT_ENABLED',
  message: 'This org does not use business units, so --business-unit cannot be used.',
};

export type Project = {
  campaigns?: string[];
  flows?: string[];
  /** `workspace/type/ApiName`. */
  cms?: string[];
};

/** A project folder under the OS temp directory with campaign, flow and CMS component files. */
export async function project(content: Project): Promise<string> {
  const root = await tempFolder();
  const put = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  };
  for (const name of content.campaigns ?? []) {
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await put(campaignPath(root, name), serializeCampaignFile({ name, fields: {} }));
  }
  for (const apiName of content.flows ?? []) {
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await put(flowPaths(root, apiName).xml, FLOW_FILE);
  }
  for (const component of content.cms ?? []) {
    const [workspace, type, apiName] = component.split('/');
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await put(join(root, 'cms', workspace, type, `${apiName}.${type}.json`), '{}');
  }
  return root;
}
