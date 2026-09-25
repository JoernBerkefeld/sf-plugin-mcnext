import { Connection, Org, SfError } from '@salesforce/core';

/** API version against which the retained v1 endpoints were verified. */
export const TESTED_API_VERSION = '67.0';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type RequestOptions = {
  path: string;
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  itemsKey?: string;
  pageSizeParam?: string;
  requireItemsKey?: boolean;
  requireCompletePagination?: boolean;
};

export type PaginationLimits = {
  maxPages?: number;
  maxItems?: number;
  maxDurationMs?: number;
};

type PagedEnvelope = Record<string, unknown> & {
  nextPageUrl?: string;
  nextPageUri?: string;
  nextRecordsUrl?: string;
  offset?: number;
  offSet?: number;
  batchSize?: number;
  limit?: number;
  totalSize?: number;
  totalCount?: number;
};

type PaginationState = {
  emitted: number;
  pageCount: number;
  offset: number;
  next?: string;
};

const DEFAULT_LIMITS: Required<PaginationLimits> = {
  maxPages: 1000,
  maxItems: 1_000_000,
  maxDurationMs: 15 * 60 * 1000,
};

function assertWithinLimits(state: PaginationState, limits: Required<PaginationLimits>, started: number): void {
  if (state.pageCount >= limits.maxPages) {
    throw new SfError(`Pagination exceeded ${limits.maxPages} pages.`, 'PaginationPageLimitError');
  }
  if (Date.now() - started >= limits.maxDurationMs) {
    throw new SfError(`Pagination exceeded ${limits.maxDurationMs} ms.`, 'PaginationTimeLimitError');
  }
}

function assertItemLimit(itemCount: number, maxItems: number): void {
  if (itemCount > maxItems) {
    throw new SfError(`Pagination exceeded ${maxItems} items.`, 'PaginationItemLimitError');
  }
}

function assertNonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SfError(`Pagination ${label} must be a finite nonnegative integer.`, 'PaginationEnvelopeError');
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SfError(`Pagination ${label} must be a finite positive integer.`, 'PaginationEnvelopeError');
  }
}

function validateCompletePage(
  pageOffset: unknown,
  servedPageSize: unknown,
  totalItems: unknown,
  currentOffset: number,
  itemCount: number
): void {
  assertNonnegativeInteger(totalItems, 'total count');
  assertNonnegativeInteger(pageOffset, 'offset');
  assertPositiveInteger(servedPageSize, 'page size');
  if (pageOffset !== currentOffset) {
    throw new SfError('Pagination metadata is inconsistent with the requested page.', 'PaginationEnvelopeError');
  }
  if (pageOffset + itemCount > totalItems) {
    throw new SfError('Pagination page exceeds the declared total count.', 'PaginationEnvelopeError');
  }
  if (pageOffset + itemCount < totalItems && itemCount !== servedPageSize) {
    throw new SfError('Pagination returned a premature short page before the declared total.', 'PaginationEnvelopeError');
  }
}

function getNextOffset(
  page: PagedEnvelope,
  itemCount: number,
  requestedPageSize: number,
  pageSizeParam: string | undefined,
  currentOffset: number,
  requireCompletePagination = false
): number | undefined {
  const pageOffset = page.offset ?? page.offSet;
  const servedPageSize = page.batchSize ?? page.limit;
  const totalItems = page.totalSize ?? page.totalCount;
  if (requireCompletePagination) {
    validateCompletePage(pageOffset, servedPageSize, totalItems, currentOffset, itemCount);
  }

  const effectivePageSize = servedPageSize ?? requestedPageSize;
  const hasMore = totalItems === undefined || (pageOffset ?? 0) + itemCount < totalItems;
  if (!pageSizeParam || typeof pageOffset !== 'number' || itemCount !== effectivePageSize || !hasMore) return undefined;
  const nextOffset = pageOffset + effectivePageSize;
  if (nextOffset <= currentOffset) {
    throw new SfError(`Pagination offset did not advance beyond ${currentOffset}.`, 'PaginationLoopError');
  }
  return nextOffset;
}

/** Thin wrapper around a Salesforce connection for retained MCN v1 REST calls. */
export class McnClient {
  private constructor(private readonly connection: Connection, public readonly apiVersion: string) {}

  /** Build a client pinned to the tested v67 baseline. */
  public static async create(org: Org, apiVersion = TESTED_API_VERSION): Promise<McnClient> {
    if (apiVersion !== TESTED_API_VERSION) {
      throw new SfError(
        `API version ${apiVersion} is not enabled for MCN v1. The retained endpoints were tested only with v${TESTED_API_VERSION}.`,
        'UnsupportedApiVersionError',
        [`Use --api-version ${TESTED_API_VERSION}.`]
      );
    }

    // eslint-disable-next-line sf-plugin/get-connection-with-version -- unversioned connection is used only for discovery
    const probe = org.getConnection();
    const orgMaximum = await probe.retrieveMaxApiVersion();
    if (Number.parseFloat(orgMaximum) < Number.parseFloat(TESTED_API_VERSION)) {
      throw new SfError(
        `The org maximum API version is ${orgMaximum}; MCN v1 was tested against v${TESTED_API_VERSION}.`,
        'ApiVersionUnavailableError'
      );
    }

    return new McnClient(org.getConnection(TESTED_API_VERSION), TESTED_API_VERSION);
  }

  private static toSfError(error: unknown, method: HttpMethod, url: string): SfError {
    const context = `${method} ${url}`;
    if (Array.isArray(error) && error.length > 0) {
      const first = error[0] as { errorCode?: string; message?: string };
      return new SfError(`${first.message ?? 'Request failed'} (${context})`, first.errorCode ?? 'McnRequestError');
    }
    if (error instanceof Error) {
      const code = (error as { errorCode?: string }).errorCode ?? 'McnRequestError';
      return new SfError(`${error.message} (${context})`, code);
    }
    return new SfError(`Request failed (${context})`, 'McnRequestError');
  }

  private static extractBatch<T>(page: PagedEnvelope, itemsKey?: string, requireItemsKey = false): T[] {
    if (itemsKey) {
      const declared = page[itemsKey];
      if (requireItemsKey && !Array.isArray(declared)) {
        throw new SfError(`Pagination response is missing array property "${itemsKey}".`, 'PaginationEnvelopeError');
      }
      return Array.isArray(declared) ? (declared as T[]) : [];
    }
    if (Array.isArray(page.records)) {
      return page.records as T[];
    }
    const arrays = Object.values(page).filter((value) => Array.isArray(value));
    return arrays.length === 1 ? (arrays[0] as T[]) : [];
  }

  /** Issue a single request and return the parsed body. */
  public async request<T>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query);
    try {
      return await this.connection.request<T>({
        method: options.method ?? 'GET',
        url,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      throw McnClient.toSfError(error, options.method ?? 'GET', url);
    }
  }

  /** Yield bounded pages so export writers can process rows incrementally. */
  public async *requestPages<T>(
    options: RequestOptions,
    pageSize = 200,
    limits: PaginationLimits = {}
  ): AsyncGenerator<T[]> {
    const effective = { ...DEFAULT_LIMITS, ...limits };
    const started = Date.now();
    const requestedPageSize = options.pageSizeParam
      ? Number(options.query?.[options.pageSizeParam] ?? pageSize)
      : pageSize;
    const visitedPointers = new Set<string>();
    let state: PaginationState = { emitted: 0, pageCount: 0, offset: Number(options.query?.offset ?? 0) };

    for (;;) {
      assertWithinLimits(state, effective, started);
      /* eslint-disable no-await-in-loop -- every request depends on the prior response cursor */
      const page = await this.fetchPage(options, requestedPageSize, state);
      /* eslint-enable no-await-in-loop */
      const batch = McnClient.extractBatch<T>(page, options.itemsKey, options.requireItemsKey);
      const emitted = state.emitted + batch.length;
      assertItemLimit(emitted, effective.maxItems);
      state = { ...state, emitted, pageCount: state.pageCount + 1 };
      yield batch;

      const offset = getNextOffset(
        page,
        batch.length,
        requestedPageSize,
        options.pageSizeParam,
        state.offset,
        options.requireCompletePagination
      );
      const pointer = page.nextPageUrl ?? page.nextPageUri ?? page.nextRecordsUrl;
      if (pointer) {
        state = {
          ...state,
          ...(offset === undefined ? {} : { offset }),
          next: this.acceptPointer(pointer, visitedPointers, options.requireCompletePagination ? offset : undefined),
        };
        continue;
      }
      if (offset === undefined) return;
      state = { ...state, offset, next: undefined };
    }
  }

  /** Follow every bounded page and concatenate its items. */
  public async requestAll<T>(options: RequestOptions, pageSize = 200, limits: PaginationLimits = {}): Promise<T[]> {
    const collected: T[] = [];
    for await (const page of this.requestPages<T>(options, pageSize, limits)) {
      collected.push(...page);
    }
    return collected;
  }

  private async fetchPage(options: RequestOptions, pageSize: number, state: PaginationState): Promise<PagedEnvelope> {
    if (state.next) {
      return this.requestAbsolute<PagedEnvelope>(state.next);
    }
    return this.request<PagedEnvelope>({
      ...options,
      query: {
        ...options.query,
        ...(options.pageSizeParam ? { [options.pageSizeParam]: pageSize, offset: state.offset } : {}),
      },
    });
  }

  private acceptPointer(pointer: string, visited: Set<string>, expectedOffset?: number): string {
    const normalized = this.normalizePointer(pointer);
    if (visited.has(normalized)) {
      throw new SfError(`Pagination repeated pointer ${normalized}.`, 'PaginationLoopError');
    }
    if (expectedOffset !== undefined) {
      const pointerOffset = Number(new URL(normalized, 'https://pagination.invalid').searchParams.get('offset'));
      if (!Number.isSafeInteger(pointerOffset) || pointerOffset !== expectedOffset) {
        throw new SfError('Pagination pointer does not advance to the expected offset.', 'PaginationEnvelopeError');
      }
    }
    visited.add(normalized);
    return normalized;
  }

  private async requestAbsolute<T>(url: string): Promise<T> {
    try {
      return await this.connection.request<T>({ method: 'GET', url });
    } catch (error) {
      throw McnClient.toSfError(error, 'GET', url);
    }
  }

  private normalizePointer(pointer: string): string {
    if (pointer.startsWith('//')) {
      throw new SfError(`Pagination pointer uses an unsafe network path: ${pointer}.`, 'PaginationOriginError');
    }
    if (pointer.startsWith('/')) {
      return pointer;
    }
    const instanceUrl = this.connection.instanceUrl;
    const parsed = new URL(pointer);
    if (!instanceUrl || parsed.origin !== new URL(instanceUrl).origin) {
      throw new SfError(`Pagination pointer uses a different origin: ${parsed.origin}.`, 'PaginationOriginError');
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = `/services/data/v${this.apiVersion}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) {
      return base;
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        search.append(key, String(value));
      }
    }
    const queryString = search.toString();
    return queryString ? `${base}?${queryString}` : base;
  }
}
