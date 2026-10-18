import { Org, SfError } from '@salesforce/core';
import { runCampaign } from '../core/campaignCli.js';
import { runCore, type CoreRunner } from '../core/flowCli.js';
import { McnClient, PaginationLimits, RequestOptions } from '../client/mcnClient.js';

const SEGMENTS_PATH = '/ssot/segments';
const DEFAULT_PAGE_SIZE = 200;

/** Result-only identity evidence; native uniqueness and persistence are separate gates. */
export type CampaignSegmentCorrelationResult = {
  campaignId: string;
  orgId: string;
  apiVersion: string;
  dataSpace: string;
  state: 'complete' | 'blocked';
  flows: Array<{
    flowRecordId: string;
    flowApiName: string;
    state: 'correlated' | 'no-segment' | 'blocked';
    segmentId?: string;
    segmentApiName?: string;
    segmentDefinitionId?: string;
    nativeMember?: string;
    diagnostics: string[];
  }>;
  associationPersistence: 'blocked';
  diagnostics: string[];
};

function correlationObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Correlate fresh per-flow Connect identities without authorizing native retrieval. */
// eslint-disable-next-line complexity -- one bounded read pipeline retains independent per-flow failures
export async function correlateCampaignSegmentDefinitions(
  input: {
    projectRoot: string;
    targetOrg: string;
    expectedOrgId: string;
    apiVersion: string;
    campaignId: string;
    dataSpace?: string;
  },
  services: {
    core?: CoreRunner;
    createOrg?: (targetOrg: string) => Promise<Org>;
    createClient?: (org: Org, apiVersion: string) => Promise<McnClient>;
  } = {}
): Promise<CampaignSegmentCorrelationResult> {
  const result: CampaignSegmentCorrelationResult = {
    campaignId: input.campaignId,
    orgId: input.expectedOrgId,
    apiVersion: input.apiVersion,
    dataSpace: input.dataSpace ?? 'default',
    state: 'blocked',
    flows: [],
    associationPersistence: 'blocked',
    diagnostics: [],
  };
  const core = services.core ?? runCore;
  try {
    if (
      input.apiVersion !== '67.0' ||
      result.dataSpace !== 'default' ||
      !/^00D[A-Za-z0-9]{15}$/.test(input.expectedOrgId) ||
      !/^701[A-Za-z0-9]{15}$/.test(input.campaignId) ||
      !input.projectRoot.trim() ||
      !input.targetOrg.trim() ||
      input.targetOrg.startsWith('-') ||
      input.targetOrg.includes('\0')
    )
      throw new Error('Explicit org/Campaign context, exact API 67.0 and default dataspace required');
    const org = await (services.createOrg ?? ((targetOrg): Promise<Org> => Org.create({ aliasOrUsername: targetOrg })))(
      input.targetOrg
    );
    if (org.getOrgId() !== input.expectedOrgId) throw new Error('Selected org identity mismatch');
    const campaign = await runCampaign({ ...input, operation: 'export', recordId: input.campaignId }, core);
    if (campaign.operation !== 'export') throw new Error('Fresh Campaign export required');
    const associations = campaign.diagnostics.associatedArtifacts;
    const seenFlows = new Set<string>();
    const seenMembers = new Set<string>();
    for (const entry of associations.flows ?? []) {
      const row: CampaignSegmentCorrelationResult['flows'][number] = {
        flowRecordId: String(entry.record.Id ?? ''),
        flowApiName: String(entry.record.ApiName ?? ''),
        state: 'blocked',
        diagnostics: [],
      };
      result.flows.push(row);
      const definition = entry.toolingDefinition;
      const flow = entry.toolingFlow;
      const metadata = flow?.Metadata;
      const start = correlationObject(metadata) ? metadata.start : undefined;
      const selected = entry.record.SegmentId;
      if (typeof selected === 'string') row.segmentId = selected;
      if (
        entry.status !== 'complete' ||
        !/^2aF[A-Za-z0-9]{15}$/.test(row.flowRecordId) ||
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.flowApiName) ||
        seenFlows.has(row.flowRecordId) ||
        seenMembers.has(row.flowApiName) ||
        entry.record.AssociatedRecordId !== input.campaignId ||
        !definition ||
        !flow ||
        !/^300[A-Za-z0-9]{15}$/.test(String(definition.Id)) ||
        definition.DeveloperName !== row.flowApiName ||
        !/^301[A-Za-z0-9]{15}$/.test(String(definition.LatestVersionId)) ||
        flow.Id !== definition.LatestVersionId ||
        flow.DefinitionId !== definition.Id ||
        !correlationObject(start) ||
        typeof start.triggerType !== 'string' ||
        !start.triggerType.trim()
      ) {
        row.diagnostics.push(entry.reason ?? 'Incomplete or conflicting fresh Flow identity');
        continue;
      }
      seenFlows.add(row.flowRecordId);
      seenMembers.add(row.flowApiName);
      if (
        selected === null &&
        start.triggerType !== 'Segment' &&
        (start.segment === undefined || start.segment === null)
      ) {
        row.state = 'no-segment';
      } else if (
        typeof selected !== 'string' ||
        !/^1sg[A-Za-z0-9]{15}$/.test(selected) ||
        start.triggerType !== 'Segment' ||
        start.segment !== selected ||
        !correlationObject(metadata) ||
        metadata.dataSpace !== result.dataSpace
      ) {
        row.diagnostics.push('Segment selection/start identity or dataspace mismatch; missing is not null');
      }
    }
    if (associations.status !== 'complete' || !Array.isArray(associations.flows)) {
      throw new Error(`Incomplete Campaign association discovery: ${associations.reason}`);
    }
    const selected = result.flows.filter((row) => row.segmentId && !row.diagnostics.length);
    if (!selected.length) {
      result.state = result.flows.every((row) => row.state === 'no-segment') ? 'complete' : 'blocked';
      return result;
    }
    const instance = org.getConnection(input.apiVersion).instanceUrl;
    const origin = new URL(instance);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    )
      throw new Error('Verified org instance origin is unavailable or malformed');
    const client = await (services.createClient ?? McnClient.create)(org, input.apiVersion);
    if (client.apiVersion !== input.apiVersion) throw new Error('Selected client API mismatch');
    const started = Date.now();
    const checkTime = (): void => {
      if (Date.now() - started >= 60_000) throw new Error('Segment correlation read time bound reached');
    };
    const segments: Array<Record<string, unknown>> = [];
    const seenSegments = new Set<unknown>();
    const cursors = new Set<number>([0]);
    let offset = 0;
    let total: number | undefined;
    // Keep every collection request bound to the verified context; never request a supplied cursor URL.
    // eslint-disable-next-line complexity -- validates every pointer and count before the next fixed-context request
    const collect = async (): Promise<void> => {
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        checkTime();
        // eslint-disable-next-line no-await-in-loop -- the next offset requires the previous page's validated counts
        const page = await client.request<unknown>({
          path: SEGMENTS_PATH,
          query: { dataspace: 'default', batchSize: 200, offset },
        });
        checkTime();
        if (
          !correlationObject(page) ||
          !Array.isArray(page.segments) ||
          !page.segments.every(correlationObject) ||
          !Number.isSafeInteger(page.offset) ||
          page.offset !== offset ||
          page.batchSize !== 200 ||
          !Number.isSafeInteger(page.totalSize) ||
          Number(page.totalSize) < 0 ||
          Number(page.totalSize) >= 20_000 ||
          (total !== undefined && total !== page.totalSize) ||
          page.segments.length > 200
        )
          throw new Error('Malformed or incomplete segment collection counts/envelope');
        total = Number(page.totalSize);
        const end = offset + page.segments.length;
        if (end > total || (end < total && page.segments.length !== 200))
          throw new Error('Premature short/empty segment page or conflicting total');
        for (const [alias, value] of [
          ['offSet', offset],
          ['limit', 200],
          ['totalCount', total],
          ['rowCount', page.segments.length],
        ] as const) {
          if (Object.hasOwn(page, alias) && page[alias] !== value)
            throw new Error('Conflicting segment pagination aliases');
        }
        let hasPointer = false;
        for (const key of ['nextPageUrl', 'nextPageUri', 'nextRecordsUrl']) {
          if (!Object.hasOwn(page, key)) continue;
          hasPointer = true;
          const pointer = page[key];
          if (
            typeof pointer !== 'string' ||
            !pointer ||
            pointer.trim() !== pointer ||
            pointer.startsWith('//') ||
            pointer.includes('\\') ||
            pointer.includes('#') ||
            !(pointer.startsWith('/') || pointer.startsWith(`${origin.origin}/`))
          )
            throw new Error('Unsafe segment pagination pointer');
          const url = new URL(pointer, origin);
          const route = `/services/data/v${input.apiVersion}${SEGMENTS_PATH}`;
          const rawRoute = pointer.startsWith('/')
            ? pointer.split('?')[0]
            : pointer.slice(origin.origin.length).split('?')[0];
          const keys = [...url.searchParams.keys()];
          const next = url.searchParams.get('offset');
          if (
            url.origin !== origin.origin ||
            url.username ||
            url.password ||
            url.hash ||
            url.pathname !== route ||
            rawRoute !== route ||
            keys.length !== 3 ||
            new Set(keys).size !== 3 ||
            keys.some((name) => !['dataspace', 'batchSize', 'offset'].includes(name)) ||
            url.searchParams.get('dataspace') !== 'default' ||
            url.searchParams.get('batchSize') !== '200' ||
            next === null ||
            !/^(0|[1-9]\d*)$/.test(next) ||
            !Number.isSafeInteger(Number(next)) ||
            Number(next) !== end ||
            end <= offset ||
            cursors.has(Number(next))
          )
            throw new Error('Unsafe or conflicting segment pagination context');
        }
        if (end === total && hasPointer) throw new Error('Terminal segment page has continuation');
        for (const segment of page.segments) {
          if (
            typeof segment.marketSegmentId !== 'string' ||
            !/^1sg[A-Za-z0-9]{15}$/.test(segment.marketSegmentId) ||
            seenSegments.has(segment.marketSegmentId)
          )
            throw new Error('Malformed or repeated segment collection identity');
          seenSegments.add(segment.marketSegmentId);
          segments.push(segment);
        }
        if (segments.length >= 20_000) throw new Error('Segment item bound reached');
        if (end === total) return;
        if (end <= offset || cursors.has(end)) throw new Error('Repeated segment cursor');
        cursors.add(end);
        offset = end;
      }
      throw new Error('Segment collection page bound reached before completion');
    };
    await collect();
    const details = new Map<string, Record<string, unknown>>();
    for (const row of selected) {
      try {
        const matches = segments.filter((segment) => segment.marketSegmentId === row.segmentId);
        const descriptor = matches[0];
        if (
          matches.length !== 1 ||
          typeof descriptor.apiName !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_]*$/.test(descriptor.apiName) ||
          typeof descriptor.marketSegmentDefinitionId !== 'string' ||
          !/^3HX[A-Za-z0-9]{15}$/.test(descriptor.marketSegmentDefinitionId) ||
          descriptor.dataSpace !== 'default' ||
          segments.filter(
            (segment) =>
              segment.apiName === descriptor.apiName ||
              segment.marketSegmentDefinitionId === descriptor.marketSegmentDefinitionId
          ).length !== 1
        )
          throw new Error('Absent, ambiguous or malformed exact segment list identity');
        let detail = details.get(descriptor.apiName);
        if (!detail) {
          checkTime();
          // eslint-disable-next-line no-await-in-loop -- per-flow reads reuse already verified shared detail identities
          const body = await client.request<unknown>({
            path: `${SEGMENTS_PATH}/${encodeURIComponent(descriptor.apiName)}`,
          });
          checkTime();
          if (
            !correlationObject(body) ||
            !Array.isArray(body.segments) ||
            body.segments.length !== 1 ||
            !correlationObject(body.segments[0])
          )
            throw new Error('Raw segment detail must contain exactly one descriptor');
          detail = body.segments[0];
          if (
            ['apiName', 'marketSegmentId', 'marketSegmentDefinitionId', 'dataSpace'].some(
              (key) => detail?.[key] !== descriptor[key]
            )
          )
            throw new Error('Segment list/detail identity mismatch');
          details.set(descriptor.apiName, detail);
        }
        row.segmentApiName = descriptor.apiName;
        row.segmentDefinitionId = descriptor.marketSegmentDefinitionId;
        row.state = 'correlated';
        row.diagnostics.push('Connect identity verified; native uniqueness not proven');
      } catch (error) {
        row.diagnostics.push(String(error));
      }
    }
    const correlated = result.flows.filter((row) => row.state === 'correlated');
    if (correlated.length) {
      const blocked = 'native metadata-list completeness unqualified';
      result.diagnostics.push(blocked);
      for (const row of correlated) row.diagnostics.push(blocked);
      try {
        const native = await core(
          [
            'org',
            'list',
            'metadata',
            '--metadata-type',
            'MarketSegmentDefinition',
            '--target-org',
            input.targetOrg,
            '--api-version',
            input.apiVersion,
            '--json',
          ],
          input.projectRoot
        );
        const envelope: unknown = JSON.parse(native.stdout);
        if (
          native.exitCode !== 0 ||
          !correlationObject(envelope) ||
          envelope.status !== 0 ||
          !Array.isArray(envelope.result)
        )
          throw new Error('Native metadata-list failed or returned malformed FileProperties array');
        if (Object.hasOwn(envelope, 'warnings') && (!Array.isArray(envelope.warnings) || envelope.warnings.length))
          throw new Error('Native metadata-list warning/partial evidence');
        for (const row of correlated) {
          const observations = envelope.result.filter(
            (entry: unknown) => correlationObject(entry) && entry.id === row.segmentDefinitionId
          );
          row.diagnostics.push(
            `Native selected definition identity observations: ${observations.length}; not exhaustive uniqueness proof`
          );
          const observation: unknown = observations[0];
          if (
            observations.length !== 1 ||
            !correlationObject(observation) ||
            observation.type !== 'MarketSegmentDefinition' ||
            typeof observation.fullName !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_]*$/.test(observation.fullName) ||
            observation.fileName !== `marketSegmentDefinitions/${observation.fullName}.marketSegmentDefinition` ||
            envelope.result.some(
              (entry: unknown) =>
                correlationObject(entry) &&
                entry.fullName === observation.fullName &&
                entry.id !== row.segmentDefinitionId
            )
          ) {
            row.state = 'blocked';
            row.diagnostics.push('Native selected identity observations absent, ambiguous or inconsistent');
          }
        }
      } catch (error) {
        result.diagnostics.push(String(error));
        for (const row of correlated) {
          row.state = 'blocked';
          row.diagnostics.push(String(error));
        }
      }
    }
  } catch (error) {
    result.diagnostics.push(String(error));
    for (const row of result.flows.filter((flow) => flow.state === 'blocked')) row.diagnostics.push(String(error));
  }
  return result;
}

/** Segment metadata used to resolve a member request selection. */
export type SegmentDescriptor = Record<string, unknown> & {
  apiName?: string;
  displayName?: string;
  marketSegmentId?: string;
  dataSpace?: string;
  segmentMembershipDmo?: unknown;
  segmentOnApiName?: unknown;
};

/** Optional filters and hooks for segment selection resolution. */
export type ResolveSegmentOptions = {
  dataSpace?: string;
  /** When more than one candidate remains, select one (interactive adapters inject this). */
  resolveAmbiguous?: (candidates: SegmentDescriptor[]) => Promise<SegmentDescriptor>;
};

/** One member row returned by the SSOT segment-members endpoint. */
export type SegmentMember = Record<string, unknown>;

/** Query and safety options accepted by the segment-members service. */
export type SegmentMembersOptions = {
  fields?: string;
  filters?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
  paginationLimits?: PaginationLimits;
};

/** Resolved segment API name and all returned member rows. */
export type SegmentMembersResult = {
  segmentApiName: string;
  data: SegmentMember[];
};

/** Build the verified segment-members request after resolving the segment selection. */
export async function createSegmentMembersRequest(
  client: McnClient,
  segment: string,
  options: SegmentMembersOptions = {},
  resolvedSegmentApiName?: string,
  resolveOptions: ResolveSegmentOptions = {}
): Promise<{ segmentApiName: string; request: RequestOptions; pageSize: number }> {
  const segmentApiName = resolvedSegmentApiName ?? (await resolveSegmentApiName(client, segment, resolveOptions));
  const pageSize = options.limit ?? DEFAULT_PAGE_SIZE;
  return {
    segmentApiName,
    pageSize,
    request: {
      path: `${SEGMENTS_PATH}/${encodeURIComponent(segmentApiName)}/members`,
      itemsKey: 'data',
      pageSizeParam: 'limit',
      query: {
        fields: options.fields,
        filters: options.filters,
        orderBy: options.orderBy,
        limit: pageSize,
        offset: options.offset ?? 0,
      },
    },
  };
}

/** List segment descriptors through the verified SSOT collection envelope. */
export async function listSegments(client: McnClient): Promise<SegmentDescriptor[]> {
  return client.requestAll<SegmentDescriptor>(
    { path: SEGMENTS_PATH, itemsKey: 'segments', pageSizeParam: 'batchSize' },
    DEFAULT_PAGE_SIZE
  );
}

/** Fetch one segment descriptor by API name. */
export async function showSegment(client: McnClient, apiName: string): Promise<SegmentDescriptor> {
  const body = await client.request<unknown>({
    path: `${SEGMENTS_PATH}/${encodeURIComponent(apiName)}`,
  });
  const segments =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).segments
      : undefined;
  const segment = Array.isArray(segments) && segments.length === 1 ? (segments as unknown[])[0] : undefined;
  const candidateApiName =
    typeof segment === 'object' && segment !== null && !Array.isArray(segment)
      ? (segment as SegmentDescriptor).apiName
      : undefined;
  const resolvedApiName = typeof candidateApiName === 'string' ? candidateApiName.trim() : undefined;
  if (!resolvedApiName) {
    throw new SfError(
      'Segment detail response must contain exactly one segment with a non-empty apiName.',
      'InvalidSegmentDetailResponse'
    );
  }
  return { ...(segment as SegmentDescriptor), apiName: resolvedApiName };
}

/** Resolve an API name directly, or through an exact MarketSegment ID or display-name match, and return its detail envelope. */
export async function resolveSegment(
  client: McnClient,
  selection: string,
  options: ResolveSegmentOptions = {}
): Promise<SegmentDescriptor> {
  let directError: unknown;
  try {
    return await showSegment(client, selection);
  } catch (error) {
    if ((error as Error).name !== 'ITEM_NOT_FOUND') throw error;
    directError = error;
  }

  const segments = await listSegments(client);
  const exactApiName = segments.find((segment) => segment.apiName === selection)?.apiName;
  if (exactApiName) return showSegment(client, exactApiName);

  const matches = segments.filter(
    (segment) => segment.marketSegmentId === selection || segment.displayName === selection
  );
  if (matches.length === 0) throw directError;

  const detailsByApiName = new Map<string, SegmentDescriptor>();
  const enriched = await enrichSegmentDataSpaces(client, matches, detailsByApiName);
  const selected = await disambiguateSegmentMatches(selection, enriched, options);
  if (!selected.apiName) {
    throw new SfError(`Segment selection "${selection}" resolved without an API name.`, 'InvalidSegmentDetailResponse');
  }
  const detail = detailsByApiName.get(selected.apiName.trim()) ?? (await showSegment(client, selected.apiName));
  if (
    ['apiName', 'marketSegmentId', 'dataSpace'].some(
      (key) => selected[key] !== undefined && detail[key] !== undefined && selected[key] !== detail[key]
    )
  ) {
    throw new SfError('Selected segment list and detail identities do not match.', 'InvalidSegmentDetailResponse');
  }
  return {
    ...detail,
    ...(typeof selected.dataSpace === 'string' && detail.dataSpace === undefined
      ? { dataSpace: selected.dataSpace }
      : {}),
  };
}

/** Resolve a segment selection to its canonical API name without requiring a second detail request. */
export async function resolveSegmentApiName(
  client: McnClient,
  selection: string,
  options: ResolveSegmentOptions = {}
): Promise<string> {
  const segment = await resolveSegment(client, selection, options);
  if (typeof segment.apiName !== 'string' || !segment.apiName.trim()) {
    throw new SfError(
      'Segment detail response must contain exactly one segment with a non-empty apiName.',
      'InvalidSegmentDetailResponse'
    );
  }
  return segment.apiName;
}

/** Attach dataSpace from list rows or one showSegment call per distinct API name. */
export async function enrichSegmentDataSpaces(
  client: McnClient,
  candidates: SegmentDescriptor[],
  detailsByApiName = new Map<string, SegmentDescriptor>()
): Promise<SegmentDescriptor[]> {
  const result: SegmentDescriptor[] = [];
  for (const candidate of candidates) {
    if (typeof candidate.dataSpace === 'string' && candidate.dataSpace.trim()) {
      result.push({ ...candidate, dataSpace: candidate.dataSpace.trim() });
      continue;
    }
    const apiName = typeof candidate.apiName === 'string' ? candidate.apiName.trim() : '';
    if (!apiName || candidates.filter((row) => row.apiName === candidate.apiName).length > 1) {
      result.push({ ...candidate });
      continue;
    }
    let detail = detailsByApiName.get(apiName);
    if (!detail) {
      // eslint-disable-next-line no-await-in-loop -- one detail fetch per distinct API name
      detail = await showSegment(client, apiName);
      detailsByApiName.set(apiName, detail);
    }
    const dataSpace =
      typeof detail.dataSpace === 'string' && detail.dataSpace.trim() ? detail.dataSpace.trim() : undefined;
    result.push(dataSpace === undefined ? { ...candidate } : { ...candidate, dataSpace });
  }
  return result;
}

async function disambiguateSegmentMatches(
  selection: string,
  matches: SegmentDescriptor[],
  options: ResolveSegmentOptions
): Promise<SegmentDescriptor> {
  const candidates = matches;
  const requestedSpace =
    typeof options.dataSpace === 'string' && options.dataSpace.trim() ? options.dataSpace.trim() : undefined;

  if (requestedSpace !== undefined) {
    const inSpace = candidates.filter((segment) => segment.dataSpace === requestedSpace);
    if (inSpace.length === 1) return inSpace[0];
    if (inSpace.length === 0) {
      const spaces = uniqueDataSpaces(candidates);
      throw new SfError(
        [
          `No segment matching "${selection}" was found in data space ${requestedSpace}.`,
          spaces.length
            ? `Matching data spaces: ${spaces.join(', ')}.`
            : 'Matching candidates did not report a data space; re-run with --segment <Id from the browser URL>.',
        ].join(' '),
        'AmbiguousSegmentError'
      );
    }
    throw new SfError(formatAmbiguousSegmentMessage(selection, inSpace), 'AmbiguousSegmentError');
  }

  if (candidates.length === 1) return candidates[0];

  const unresolvedSharedApiName = candidates.some(
    (candidate) => !candidate.dataSpace && candidates.filter((row) => row.apiName === candidate.apiName).length > 1
  );
  if (options.resolveAmbiguous && !unresolvedSharedApiName) {
    return options.resolveAmbiguous(candidates);
  }

  throw new SfError(formatAmbiguousSegmentMessage(selection, candidates), 'AmbiguousSegmentError');
}

function formatAmbiguousSegmentMessage(selection: string, candidates: SegmentDescriptor[]): string {
  const lines = candidates.map((segment) => {
    const space =
      typeof segment.dataSpace === 'string' && segment.dataSpace.trim()
        ? segment.dataSpace.trim()
        : '(unknown data space)';
    const id =
      typeof segment.marketSegmentId === 'string' && segment.marketSegmentId.trim()
        ? segment.marketSegmentId.trim()
        : '(missing MarketSegment Id)';
    const display =
      typeof segment.displayName === 'string' && segment.displayName.trim() ? segment.displayName.trim() : selection;
    const api =
      typeof segment.apiName === 'string' && segment.apiName.trim() ? ` (API name ${segment.apiName.trim()})` : '';
    return `- data space ${space}, MarketSegment Id ${id}, display name "${display}"${api}`;
  });
  const missingSpaces = candidates.some(
    (segment) => typeof segment.dataSpace !== 'string' || !segment.dataSpace.trim()
  );
  const guidance = missingSpaces
    ? 'Re-run with --segment <Id from the browser URL> to identify the segment whose data space is unknown.'
    : 'Re-run with --segment <Id from the browser URL> or --data-space <name>.';
  return [`Segment selection "${selection}" is ambiguous:`, ...lines, guidance].join('\n');
}

function uniqueDataSpaces(candidates: SegmentDescriptor[]): string[] {
  return [
    ...new Set(
      candidates
        .map((segment) => (typeof segment.dataSpace === 'string' ? segment.dataSpace.trim() : ''))
        .filter((space) => space.length > 0)
    ),
  ].sort();
}

/** Fetch every bounded page from the verified segment-members data envelope. */
export async function getSegmentMembers(
  client: McnClient,
  segment: string,
  options: SegmentMembersOptions = {}
): Promise<SegmentMembersResult> {
  const { segmentApiName, request, pageSize } = await createSegmentMembersRequest(client, segment, options);
  const data = await client.requestAll<SegmentMember>(request, pageSize, options.paginationLimits);
  return { segmentApiName, data };
}
