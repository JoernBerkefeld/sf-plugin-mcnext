import type { Connection } from '@salesforce/core';
import { resolveBusinessUnit, type TargetScope } from '../business-units.js';
import { retrieveCampaigns } from '../campaign/retrieve.js';
import { emptyEnvelope, type Envelope, type Item, type Status } from '../envelope.js';
import { retrieveFlows } from '../flow/retrieve.js';
import {
  cmsExitCodeOf,
  cmsRetrieve,
  data360ExitCodeOf,
  runRetrieve,
  type Data360RetrieveEnvelope,
} from '../libraries.js';
import type { MetadataSelector } from '../selectors.js';
import {
  codeOf,
  messageOf,
  newPhase,
  orgIdOf,
  parseSelection,
  recordCms,
  refuse,
  refused,
  selectorText,
  withPhase,
  type Phase,
} from './shared.js';

export type RetrieveOptions = {
  /** `-m` values; none: every campaign and every marketing flow. */
  metadata?: string[];
  /** Project folder the files are written to. */
  outputDir: string;
  /** Developer name of a business unit: its campaigns, flows, data space and CMS workspaces. */
  businessUnit?: string;
  /** CMS workspace of the CMS selectors. */
  workspace?: string;
  /** Data space of the Data 360 selectors; default: the business unit's, else `default`. */
  dataspace?: string;
};

export type RetrieveDeps = {
  resolveBusinessUnit: typeof resolveBusinessUnit;
  retrieveCampaigns: typeof retrieveCampaigns;
  retrieveFlows: (
    ...args: [Parameters<typeof retrieveFlows>[0], Parameters<typeof retrieveFlows>[1]]
  ) => Promise<Item[]>;
  runRetrieve: typeof runRetrieve;
  cmsRetrieve: typeof cmsRetrieve;
  data360ExitCodeOf: typeof data360ExitCodeOf;
  cmsExitCodeOf: typeof cmsExitCodeOf;
};

const DEFAULT_DEPS: RetrieveDeps = {
  resolveBusinessUnit,
  retrieveCampaigns,
  retrieveFlows,
  runRetrieve,
  cmsRetrieve,
  data360ExitCodeOf,
  cmsExitCodeOf,
};

/** What one run retrieves, after its flags are checked. */
type Request = {
  connection: Connection;
  deps: RetrieveDeps;
  outputDir: string;
  /** No `-m`: everything of the scope. */
  everything: boolean;
  selectors: MetadataSelector[];
  scope?: TargetScope;
  workspace?: string;
  dataspace?: string;
};

type Data360Part = {
  envelope?: Data360RetrieveEnvelope;
  items: Item[];
  code: Status;
  warnings: string[];
  errors: Envelope['errors'];
};

function selected(request: Request, area: MetadataSelector['area'], type?: string): MetadataSelector[] {
  return request.selectors.filter(
    (selector) => selector.area === area && (type === undefined || selector.type === type)
  );
}

/** Names of the selectors of one type; undefined when one of them is bare (every component). */
function namesOf(selectors: MetadataSelector[]): string[] | undefined {
  return selectors.length === 0 || selectors.some((selector) => selector.name === undefined)
    ? undefined
    : selectors.map((selector) => selector.name as string);
}

/** The rows of a `sf data360 retrieve` envelope as items. */
function data360Items(result: Data360RetrieveEnvelope): Item[] {
  return result.result.items.map((row) => ({
    area: 'data360',
    // A row without a family is told by its folder below data360/.
    type: row.family ?? /data360[\\/]([^\\/]+)[\\/]/u.exec(row.path)?.[1] ?? 'data360',
    name: row.identity.apiName,
    outcome: row.outcome,
    path: row.path,
  }));
}

async function retrieveData360(request: Request): Promise<Data360Part | undefined> {
  const selectors = selected(request, 'data360');
  if (selectors.length === 0 && !(request.everything && request.scope)) return undefined;
  try {
    const result = await request.deps.runRetrieve(request.connection, {
      dataspace: request.dataspace ?? request.scope?.dataSpace ?? 'default',
      ...(request.everything ? {} : { metadata: selectors.map(selectorText) }),
      outputDir: request.outputDir,
    });
    return {
      envelope: result,
      items: data360Items(result),
      code: request.deps.data360ExitCodeOf(result),
      warnings: result.diagnostics.warnings,
      errors: result.diagnostics.errors.map((error) => ({
        code: error.code,
        message: error.identity ? `${error.identity.apiName}: ${error.message}` : error.message,
        area: 'data360',
      })),
    };
  } catch (error) {
    return {
      items: [],
      code: 1,
      warnings: [],
      errors: [{ code: codeOf(error) ?? 'DATA360_RETRIEVE_FAILED', message: messageOf(error), area: 'data360' }],
    };
  }
}

/** One `sf-plugin-cms` retrieve per workspace. */
async function retrieveCms(request: Request, phase: Phase): Promise<void> {
  const selectors = selected(request, 'cms');
  if (selectors.length === 0 && !(request.everything && request.scope)) return;
  const workspaces = request.workspace ? [request.workspace] : request.scope?.workspaces ?? [];
  for (const workspace of workspaces) {
    // One workspace after the other: the areas never run in parallel.
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    const result = await request.deps.cmsRetrieve(request.connection, {
      workspace,
      ...(request.everything ? {} : { metadata: selectors.map(selectorText) }),
      outputDirectory: request.outputDir,
    });
    recordCms(phase, result, request.deps.cmsExitCodeOf(result));
  }
}

/** Campaigns, then flows: this plugin's own types. */
async function retrieveOwn(request: Request): Promise<Item[]> {
  const { connection, deps, outputDir, scope, everything } = request;
  const items: Item[] = [];
  const campaigns = selected(request, 'mcnext', 'campaign');
  if (everything || campaigns.length > 0) {
    const names = namesOf(campaigns);
    items.push(
      ...(await deps.retrieveCampaigns(connection, {
        ...(names ? { names } : {}),
        ...(scope ? { businessUnitId: scope.businessUnit.id } : {}),
        outputDir,
      }))
    );
  }
  const flows = selected(request, 'mcnext', 'flow');
  if (everything || flows.length > 0) {
    const apiNames = namesOf(flows);
    items.push(
      ...(await deps.retrieveFlows(connection, {
        ...(apiNames ? { apiNames } : {}),
        ...(scope
          ? { dataSpace: scope.dataSpace, dataSpaceId: scope.dataSpaceId }
          : request.dataspace
          ? { dataSpace: request.dataspace }
          : {}),
        outputDir,
      }))
    );
  }
  return items;
}

/**
 * Retrieve into the project folder. Existing files are replaced.
 *
 * Without `-m` and without a business unit: every campaign and every marketing flow. With a
 * business unit: its campaigns, the flows of its data space, the Data 360 components of that data
 * space and the content of its CMS workspaces. `-m` narrows the run to what it names. The areas
 * run one after another. Nothing is printed and nothing is thrown for a failing component.
 */
export async function retrieve(
  connection: Connection,
  options: RetrieveOptions,
  deps: RetrieveDeps = DEFAULT_DEPS
): Promise<Envelope> {
  const envelope = emptyEnvelope('retrieve', false, orgIdOf(connection));
  const parsed = parseSelection(options.metadata, undefined, options.outputDir);
  if (!parsed.ok) return refused(envelope, parsed.errors);
  const selectors = parsed.selection.metadata;
  const cmsSelectors = selectors.filter((selector) => selector.area === 'cms');
  if (cmsSelectors.length > 0 && !options.workspace && !options.businessUnit)
    return refuse(
      envelope,
      'WORKSPACE_REQUIRED',
      `Name the CMS workspace of ${cmsSelectors.map(selectorText).join(', ')} with --workspace, ` +
        'or retrieve a whole business unit with --business-unit.',
      'cms'
    );

  let scope: TargetScope | undefined;
  if (options.businessUnit) {
    const resolved = await deps.resolveBusinessUnit(connection, options.businessUnit);
    if (!resolved.ok) return refuse(envelope, resolved.code, resolved.message);
    scope = resolved.scope;
  }
  const request: Request = {
    connection,
    deps,
    outputDir: options.outputDir,
    everything: selectors.length === 0,
    selectors,
    ...(scope ? { scope } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.dataspace ? { dataspace: options.dataspace } : {}),
  };

  const phase = newPhase();
  const data360 = await retrieveData360(request);
  if (data360) {
    phase.items.push(...data360.items);
    phase.codes.push(data360.code);
  }
  await retrieveCms(request, phase);
  phase.items.push(...(await retrieveOwn(request)));

  return withPhase(
    {
      ...envelope,
      areas: data360?.envelope ? { data360: data360.envelope } : {},
      warnings: data360?.warnings ?? [],
      errors: data360?.errors ?? [],
    },
    phase
  );
}
