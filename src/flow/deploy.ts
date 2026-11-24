import { readFile } from 'node:fs/promises';
import type { Connection } from '@salesforce/core';
import { placeDmo, translateSegmentName } from 'salesforce-data360-rules';
import { campaignKey } from '../campaign/file.js';
import type { Item } from '../envelope.js';
import {
  crossSpaceContext,
  flowContentReference,
  getItems,
  parseFlowContentReference,
  resolveSegment,
} from '../libraries.js';
import {
  apiNameOfFlowFile,
  FlowFileError,
  getDataSpace,
  getStartObject,
  getStartSegment,
  getStatus,
  parseSidecar,
  replaceContentIds,
  setDataSpace,
  setStartObject,
  setStartSegment,
  sidecarPathOf,
  type ContentNeed,
  type FlowSidecar,
} from './file.js';
import {
  codeOf,
  describeError,
  findCampaignIds,
  findFlowRecord,
  flowItem,
  readCampaignScope,
  sameId,
  setAssociatedRecord,
  type CampaignScope,
  type FlowRecordRow,
} from './link.js';
import { deployFlow, retrieveFlow } from './metadata.js';
import { contentNeeds, isSegmentId } from './retrieve.js';

export type DeployFlowsOptions = {
  /** Flow files (`<ApiName>.flow-meta.xml`); the sidecar is read from beside each. */
  files: string[];
  /** Report what would happen; write nothing. */
  preview: boolean;
  /** Without it a file whose status is `Active` is refused. */
  allowActivation: boolean;
  /** Copy into another business unit: its data space (none: the file's own), and the CMS workspace per source workspace. */
  target?: { dataSpace?: string; workspaceFor: (source: string) => string | undefined };
  /**
   * What this run creates before the flows. In a preview such a need counts as met although the
   * org does not have it yet. Keys: content `workspace/type/apiName`, campaigns
   * `businessUnit/name` (`campaignKey`; no business unit: `/name`), segments `dataSpace/apiName`,
   * each as the deployed flow names them (after the rewrite for `target`).
   */
  metInThisRun: { content: Set<string>; campaigns: Set<string>; segments: Set<string> };
};

export type DeployFlowsDeps = {
  retrieveFlow: typeof retrieveFlow;
  deployFlow: typeof deployFlow;
  resolveSegment: typeof resolveSegment;
  getItems: typeof getItems;
  crossSpaceContext: typeof crossSpaceContext;
};

const DEFAULT_DEPS: DeployFlowsDeps = { retrieveFlow, deployFlow, resolveSegment, getItems, crossSpaceContext };

/** A flow that is ready to be sent. */
type Plan = {
  apiName: string;
  path: string;
  /** The file as it is sent: segment as record ID, and rewritten for the target. */
  xml: string;
  campaign?: { name: string; id?: string };
  record?: FlowRecordRow;
  /** The org's flow already equals `xml`. */
  sameFlow: boolean;
  notes: string[];
};

/** Stops the preparation of one flow with the item that reports it. */
class Stop extends Error {
  public constructor(public readonly item: Item) {
    super(item.message);
  }
}

type Context = {
  connection: Connection;
  options: DeployFlowsOptions;
  deps: DeployFlowsDeps;
  /** Per data space of this run: the business unit its flows' campaigns are in. */
  campaignScopes: Map<string, Promise<CampaignScope>>;
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function readSidecar(path: string): Promise<FlowSidecar> {
  try {
    return parseSidecar(await readFile(sidecarPathOf(path), 'utf8'));
  } catch (error) {
    if (isMissing(error)) return { needs: [] };
    throw error;
  }
}

/** The four changes of a copy into another business unit: data space, start object, segment name, workspaces. */
async function rewriteForTarget(context: Context, apiName: string, path: string, source: string): Promise<string> {
  const { connection, options, deps } = context;
  const target = options.target as NonNullable<DeployFlowsOptions['target']>;
  const stop = (code: string, message: string): Stop => new Stop(flowItem(apiName, 'blocked', { path, code, message }));
  let xml = source;
  const from = getDataSpace(xml);
  const to = target.dataSpace;
  if (!from && to)
    throw stop(
      'FLOW_DATASPACE_MISSING',
      'The flow file has no <dataSpace>, so it cannot be moved to another data space.'
    );

  if (from && to && from.toLowerCase() !== to.toLowerCase()) {
    const object = getStartObject(xml);
    const segment = getStartSegment(xml);
    const rules = await deps.crossSpaceContext(connection, {
      from,
      to,
      names: object ? [object] : [],
    });
    if (object) {
      const placed = placeDmo(rules, object);
      if ('reason' in placed)
        throw stop('OBJECT_NOT_PLACED', `${object} has no counterpart in data space ${to}: ${placed.reason}`);
      xml = setStartObject(xml, placed.name);
    }
    if (segment) {
      if (isSegmentId(segment))
        throw stop(
          'SEGMENT_NOT_FOUND',
          `The file names its segment by record ID (${segment}), which belongs to data space ${from}. ` +
            'Retrieve the flow again so that the file holds the segment API name.'
        );
      const placed = translateSegmentName(rules, segment);
      if ('reason' in placed)
        throw stop('SEGMENT_NOT_PLACED', `Segment ${segment} has no name in data space ${to}: ${placed.reason}`);
      xml = setStartSegment(xml, placed.name);
    }
    xml = setDataSpace(xml, to);
  }

  const unmapped = new Set<string>();
  xml = replaceContentIds(xml, (contentId) => {
    let reference;
    try {
      reference = parseFlowContentReference(contentId);
    } catch {
      return contentId;
    }
    const workspace = target.workspaceFor(reference.workspaceApiName);
    if (!workspace) {
      unmapped.add(reference.workspaceApiName);
      return contentId;
    }
    return flowContentReference(workspace, reference.type, reference.apiName);
  });
  if (unmapped.size > 0)
    throw stop(
      'WORKSPACE_REQUIRED',
      `No CMS workspace of the target is chosen for the content of workspace ${[...unmapped].join(', ')}.`
    );
  return xml;
}

/** Segment API name → record ID of the target. Returns the file to send. */
async function resolveSegmentId(
  context: Context,
  apiName: string,
  path: string,
  xml: string,
  notes: string[]
): Promise<string> {
  const { connection, options, deps } = context;
  const segment = getStartSegment(xml);
  if (!segment) return xml;
  const dataSpace = getDataSpace(xml);
  if (!dataSpace)
    throw new Stop(
      flowItem(apiName, 'blocked', {
        path,
        code: 'FLOW_DATASPACE_MISSING',
        message: `The flow file has no <dataSpace>, so segment ${segment} cannot be looked up.`,
      })
    );
  try {
    const row = await deps.resolveSegment(
      connection,
      isSegmentId(segment) ? { dataSpace, marketSegmentId: segment } : { dataSpace, apiName: segment }
    );
    return setStartSegment(xml, row.marketSegmentId);
  } catch (error) {
    const code = codeOf(error);
    if (code !== 'SEGMENT_NOT_FOUND' && code !== 'SEGMENT_OTHER_DATASPACE')
      throw new Stop(
        flowItem(apiName, 'failed', { path, code: code ?? 'SEGMENT_LOOKUP_FAILED', message: describeError(error) })
      );
    if (options.preview && options.metInThisRun.segments.has(`${dataSpace}/${segment}`)) {
      notes.push(`Segment ${segment} is created in this run.`);
      return xml;
    }
    throw new Stop(
      flowItem(apiName, 'blocked', {
        path,
        code: 'SEGMENT_NOT_FOUND',
        message:
          `Segment ${segment} is not in data space ${dataSpace} of this org. Salesforce would deploy the flow ` +
          `without its segment and report no error. (${describeError(error)})`,
      })
    );
  }
}

/** Every content item the flow sends must exist in its workspace. Returns whether one is only met by this run. */
async function checkContent(
  context: Context,
  apiName: string,
  path: string,
  xml: string,
  notes: string[]
): Promise<boolean> {
  const { connection, options, deps } = context;
  const needs = contentNeeds(xml) as ContentNeed[];
  const missing: string[] = [];
  let pending = false;
  for (const workspace of new Set(needs.map((need) => need.workspace))) {
    const refs = needs
      .filter((need) => need.workspace === workspace)
      .map(({ type, apiName: name }) => ({ type, apiName: name }));
    // One workspace after the other; a flow rarely uses more than one.
    // eslint-disable-next-line no-await-in-loop -- sequential reads
    const answer = await deps.getItems(connection, { workspace, refs });
    if (answer.status !== 'success') {
      const [error] = answer.diagnostics.errors;
      throw new Stop(
        flowItem(apiName, 'failed', {
          path,
          code: error?.code ?? 'CONTENT_READ_FAILED',
          message: `The content of workspace ${workspace} could not be checked: ${error?.message ?? 'no reason given'}`,
        })
      );
    }
    for (const ref of refs) {
      const key = `${workspace}/${ref.type}/${ref.apiName}`;
      const state = answer.result.items.find(
        (item) => item.type === ref.type && item.apiName.toLowerCase() === ref.apiName.toLowerCase()
      );
      if (state?.exists) {
        if (state.isPublished === false) notes.push(`${ref.type} ${ref.apiName} in ${workspace} is not published.`);
      } else if (options.preview && options.metInThisRun.content.has(key)) {
        pending = true;
        notes.push(`${ref.type} ${ref.apiName} in ${workspace} is created in this run.`);
      } else {
        missing.push(`${ref.type} ${ref.apiName} in workspace ${workspace}`);
      }
    }
  }
  if (missing.length > 0)
    throw new Stop(
      flowItem(apiName, 'blocked', {
        path,
        code: 'CONTENT_NOT_FOUND',
        message: `Content the flow sends does not exist: ${missing.join('; ')}. Salesforce refuses a flow without it.`,
      })
    );
  return pending;
}

function campaignScopeOf(context: Context, dataSpace: string | undefined): Promise<CampaignScope> {
  const key = (dataSpace ?? '').toLowerCase();
  const known = context.campaignScopes.get(key);
  if (known) return known;
  const scope = readCampaignScope(context.connection, dataSpace);
  context.campaignScopes.set(key, scope);
  return scope;
}

/**
 * The campaign the sidecar names. With business units: the one in the business unit that owns the
 * flow's data space, else the one without a business unit; a flow cannot be attached to a campaign
 * of another business unit. Without business units: the one of that name.
 */
async function findCampaign(
  context: Context,
  flow: { apiName: string; path: string; dataSpace: string | undefined },
  name: string,
  notes: string[]
): Promise<string | undefined> {
  const { connection, options } = context;
  const { apiName, path } = flow;
  const metInThisRun = options.preview ? options.metInThisRun.campaigns : new Set<string>();
  const places: string[] = [];
  try {
    const scope = await campaignScopeOf(context, flow.dataSpace);
    const units = scope.businessUnits;
    const buckets: Array<{ unitIds?: string[] | null; where: string; inThisRun: boolean }> = scope.enabled
      ? [
          ...(units.length > 0
            ? [
                {
                  unitIds: units.map((unit) => unit.id),
                  where: ` in business unit ${units.map((unit) => unit.developerName).join(', ')}`,
                  inThisRun: units.some((unit) => metInThisRun.has(campaignKey(unit.developerName, name))),
                },
              ]
            : []),
          { unitIds: null, where: ' without a business unit', inThisRun: metInThisRun.has(campaignKey(null, name)) },
        ]
      : [
          {
            where: '',
            // Without business units the name alone is the campaign.
            inThisRun: [...metInThisRun].some((key) => key.slice(key.indexOf('/') + 1) === name),
          },
        ];
    for (const bucket of buckets) {
      places.push(bucket.where);
      // One place after the other: the second is only read when the first has no such campaign.
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      const ids = await findCampaignIds(connection, name, bucket.unitIds);
      if (ids.length === 1) return ids[0];
      if (ids.length > 1)
        throw new Stop(
          flowItem(apiName, 'blocked', {
            path,
            code: 'CAMPAIGN_NAME_AMBIGUOUS',
            message: `${ids.length} campaigns${bucket.where} are named ${name} (${ids.join(
              ', '
            )}); the flow can be attached to one only.`,
          })
        );
      if (bucket.inThisRun) {
        notes.push(`Campaign ${name} is created in this run.`);
        return undefined;
      }
    }
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop(
      flowItem(apiName, 'failed', {
        path,
        code: 'CAMPAIGN_READ_FAILED',
        message: `Campaign ${name} could not be looked up: ${describeError(error)}`,
      })
    );
  }
  const where = places.filter((place) => place !== '').join(' or');
  throw new Stop(
    flowItem(apiName, 'blocked', {
      path,
      code: 'CAMPAIGN_NOT_FOUND',
      message:
        `No campaign named ${name}${where} in this org, so the flow cannot be attached to it.` +
        (where ? ' A flow can only be attached to a campaign of the business unit that owns its data space.' : ''),
    })
  );
}
/** Reads, checks and rewrites one flow file. Throws Stop with the item when it cannot be sent. */
async function prepare(context: Context, path: string): Promise<Plan> {
  const { connection, options, deps } = context;
  const apiName = apiNameOfFlowFile(path);
  if (!apiName)
    throw new Stop(
      flowItem(path, 'failed', {
        path,
        code: 'FLOW_FILE_INVALID',
        message: 'A flow file is named <ApiName>.flow-meta.xml.',
      })
    );
  const notes: string[] = [];
  try {
    let xml = await readFile(path, 'utf8');
    const sidecar = await readSidecar(path);
    if (getStatus(xml) === 'Active' && !options.allowActivation)
      throw new Stop(
        flowItem(apiName, 'blocked', {
          path,
          code: 'ACTIVATION_NOT_ALLOWED',
          message: 'The status in the file is Active: deploying it starts the flow. Allow it with --allow-activation.',
        })
      );
    if (options.target) xml = await rewriteForTarget(context, apiName, path, xml);
    xml = await resolveSegmentId(context, apiName, path, xml, notes);
    const pendingContent = await checkContent(context, apiName, path, xml, notes);
    const campaignId = sidecar.campaign
      ? await findCampaign(
          context,
          { apiName, path, dataSpace: getDataSpace(xml) ?? undefined },
          sidecar.campaign.name,
          notes
        )
      : undefined;
    const record = await findFlowRecord(connection, apiName);

    let sameFlow = false;
    // A need that only this run meets means the org cannot hold this flow yet.
    const complete = !pendingContent && (!getStartSegment(xml) || isSegmentId(getStartSegment(xml) as string));
    if (record && complete) {
      const current = await deps.retrieveFlow(connection, apiName);
      sameFlow = current.ok && current.xml.replaceAll('\r\n', '\n') === xml.replaceAll('\r\n', '\n');
    }
    return {
      apiName,
      path,
      xml,
      ...(sidecar.campaign ? { campaign: { name: sidecar.campaign.name, id: campaignId } } : {}),
      record,
      sameFlow,
      notes,
    };
  } catch (error) {
    if (error instanceof Stop) throw error;
    const code = error instanceof FlowFileError ? error.code : codeOf(error) ?? 'FLOW_PREPARE_FAILED';
    throw new Stop(flowItem(apiName, 'failed', { path, code, message: describeError(error) }));
  }
}

function sameLink(plan: Plan): boolean {
  return (
    !plan.campaign || (plan.campaign.id !== undefined && sameId(plan.record?.associatedRecordId, plan.campaign.id))
  );
}

function withNotes(notes: string[]): { message?: string } {
  return notes.length > 0 ? { message: notes.join(' ') } : {};
}

function previewItem(plan: Plan): Item {
  const outcome = !plan.record ? 'would-create' : plan.sameFlow && sameLink(plan) ? 'unchanged' : 'would-update';
  return flowItem(plan.apiName, outcome, {
    path: plan.path,
    ...(plan.record ? { id: plan.record.id } : {}),
    ...withNotes(plan.notes),
  });
}

/**
 * Sends one prepared flow: the flow file, then the campaign link, read back. A link that failed
 * is its own item after the flow's, so that a deployed flow still counts as written.
 */
async function send(context: Context, plan: Plan): Promise<Item[]> {
  const { connection, deps } = context;
  const { apiName, path, notes } = plan;
  if (plan.record && plan.sameFlow && sameLink(plan))
    return [flowItem(apiName, 'unchanged', { path, id: plan.record.id, ...withNotes(notes) })];

  if (!plan.sameFlow) {
    const deployed = await deps.deployFlow(connection, { apiName, xml: plan.xml });
    if (deployed.status === 'unknown')
      return [
        flowItem(apiName, 'unknown', {
          path,
          code: 'FLOW_DEPLOY_UNKNOWN',
          message: `No final answer from Salesforce; the flow may or may not be deployed. ${deployed.errors.join(
            ' '
          )}`.trim(),
        }),
      ];
    if (deployed.status === 'failed')
      return [
        flowItem(apiName, 'failed', {
          path,
          code: 'FLOW_DEPLOY_FAILED',
          message: deployed.errors.join(' ') || `Salesforce answered ${deployed.requestStatus ?? 'Failed'}.`,
        }),
      ];
    notes.push(...deployed.messages);
  }
  const outcome = plan.record ? 'updated' : 'created';
  if (!plan.campaign)
    return [flowItem(apiName, outcome, { path, ...(plan.record ? { id: plan.record.id } : {}), ...withNotes(notes) })];

  const campaign = plan.campaign as { name: string; id: string };
  // The flow item says what happened to the flow itself; the link problem is the second item.
  const linkProblem = (kind: 'failed' | 'unknown', code: string, message: string, id?: string): Item[] => {
    const flowId = id ?? plan.record?.id;
    return [
      flowItem(apiName, plan.sameFlow ? 'unchanged' : outcome, {
        path,
        ...(flowId ? { id: flowId } : {}),
        ...withNotes(notes),
      }),
      {
        area: 'mcnext',
        type: 'campaign-link',
        name: apiName,
        outcome: kind,
        code,
        message: `${plan.sameFlow ? '' : 'The flow itself is deployed. '}${message}`,
      },
    ];
  };
  try {
    const record = await findFlowRecord(connection, apiName);
    if (!record)
      return linkProblem(
        'failed',
        'CAMPAIGN_LINK_FAILED',
        `Its FlowRecord row was not found, so it is not attached to campaign ${campaign.name}.`
      );
    if (sameId(record.associatedRecordId, campaign.id))
      return [flowItem(apiName, outcome, { path, id: record.id, ...withNotes(notes) })];
    const written = await setAssociatedRecord(connection, record.id, campaign.id);
    if (!written.ok)
      return written.answered
        ? linkProblem(
            'failed',
            'CAMPAIGN_LINK_FAILED',
            `Attaching it to campaign ${campaign.name} was refused: ${written.message}`,
            record.id
          )
        : linkProblem(
            'unknown',
            'CAMPAIGN_LINK_UNKNOWN',
            `No answer to attaching it to campaign ${campaign.name}: ${written.message}`,
            record.id
          );
    const readBack = await findFlowRecord(connection, apiName);
    if (!sameId(readBack?.associatedRecordId, campaign.id))
      return linkProblem(
        'failed',
        'CAMPAIGN_LINK_NOT_CONFIRMED',
        `Salesforce accepted the link to campaign ${campaign.name}, but the flow does not show it.`,
        record.id
      );
    return [flowItem(apiName, outcome, { path, id: record.id, ...withNotes(notes) })];
  } catch (error) {
    return linkProblem(
      'failed',
      'CAMPAIGN_LINK_FAILED',
      `The link to campaign ${campaign.name} could not be checked: ${describeError(error)}`
    );
  }
}

/**
 * Deploy flow files: segment API name to record ID, content and campaign checked first, then the
 * flow through the Metadata API and the campaign link on its `FlowRecord` row.
 *
 * A preview checks every flow and writes nothing. A real run stops at the first flow that is
 * blocked, failed or unknown; the flows after it are `not-attempted`. Nothing is thrown.
 */
export async function deployFlows(
  connection: Connection,
  options: DeployFlowsOptions,
  deps: DeployFlowsDeps = DEFAULT_DEPS
): Promise<Item[]> {
  const context: Context = { connection, options, deps, campaignScopes: new Map() };
  const items: Item[] = [];
  let stopped = false;
  for (const path of options.files) {
    if (stopped) {
      items.push(flowItem(apiNameOfFlowFile(path) ?? path, 'not-attempted', { path }));
    } else {
      let sent: Item[];
      try {
        // One flow after the other: the checks run directly before each flow is sent.
        // eslint-disable-next-line no-await-in-loop -- sequential by design
        const plan = await prepare(context, path);
        // eslint-disable-next-line no-await-in-loop -- sequential by design
        sent = options.preview ? [previewItem(plan)] : await send(context, plan);
      } catch (error) {
        sent = [
          error instanceof Stop
            ? error.item
            : flowItem(apiNameOfFlowFile(path) ?? path, 'failed', {
                path,
                code: 'FLOW_DEPLOY_FAILED',
                message: describeError(error),
              }),
        ];
      }
      items.push(...sent);
      stopped = !options.preview && sent.some((item) => ['failed', 'blocked', 'unknown'].includes(item.outcome));
    }
  }
  return items;
}
