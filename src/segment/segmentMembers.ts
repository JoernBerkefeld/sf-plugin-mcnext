import { SfError } from '@salesforce/core';
import { McnClient, PaginationLimits, RequestOptions } from '../client/mcnClient.js';

const SEGMENTS_PATH = '/ssot/segments';
const DEFAULT_PAGE_SIZE = 200;

/** Segment metadata used to resolve a member request selection. */
export type SegmentDescriptor = Record<string, unknown> & {
  apiName?: string;
  displayName?: string;
  marketSegmentId?: string;
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
  options: SegmentMembersOptions = {}
): Promise<{ segmentApiName: string; request: RequestOptions; pageSize: number }> {
  const segmentApiName = await resolveSegmentApiName(client, segment);
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
  return client.request<SegmentDescriptor>({
    path: `${SEGMENTS_PATH}/${encodeURIComponent(apiName)}`,
  });
}

/** Resolve an API name directly, or through an exact MarketSegment ID or display-name match. */
export async function resolveSegmentApiName(client: McnClient, selection: string): Promise<string> {
  let directError: unknown;
  try {
    const segment = await showSegment(client, selection);
    return segment.apiName ?? selection;
  } catch (error) {
    if ((error as Error).name !== 'ITEM_NOT_FOUND') throw error;
    directError = error;
  }

  const segments = await listSegments(client);
  const exactApiName = segments.find((segment) => segment.apiName === selection)?.apiName;
  if (exactApiName) return exactApiName;

  const matches = segments.filter(
    (segment) => segment.marketSegmentId === selection || segment.displayName === selection
  );
  if (matches.length === 1 && matches[0].apiName) return matches[0].apiName;
  if (matches.length > 1) {
    throw new SfError(`Segment selection "${selection}" is ambiguous. Use its API name.`, 'AmbiguousSegmentError');
  }
  throw directError;
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
