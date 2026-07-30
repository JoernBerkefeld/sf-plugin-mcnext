import { Connection, Org, SfError } from '@salesforce/core';

/** Lowest API version that exposes the documented Marketing Cloud Next endpoints. */
export const MIN_API_VERSION = 67;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type RequestOptions = {
  /** Path relative to `/services/data/v{apiVersion}`, e.g. `/ssot/segments`. */
  path: string;
  method?: HttpMethod;
  body?: unknown;
  /** Query parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
};

/**
 * Envelope shapes returned by the three pagination conventions used across
 * Marketing Cloud Next APIs. A single response only ever uses one of them.
 */
type PagedEnvelope<T> = {
  /** Connect API CMS style. */
  items?: T[];
  currentPageUrl?: string;
  currentPageUri?: string;
  nextPageUrl?: string;
  nextPageUri?: string;
  /** Data 360 `/ssot/*` style. */
  data?: T[];
  totalCount?: number;
  rowCount?: number;
  /** SOQL / sObject style. */
  records?: T[];
  nextRecordsUrl?: string;
  done?: boolean;
  totalSize?: number;
};

/**
 * Thin, typed wrapper around a Salesforce `Connection` for Marketing Cloud Next REST calls.
 *
 * Exists so that every handler shares one implementation of API-version pinning,
 * query-string building, pagination and error mapping.
 */
export class McnClient {
  private constructor(
    private readonly connection: Connection,
    public readonly apiVersion: string
  ) {}

  /**
   * Build a client from a resolved org, pinning the API version.
   *
   * @param org - the target org, typically from `Flags.requiredOrg()`
   * @param [apiVersion] - explicit API version; defaults to the org maximum
   * @returns a ready-to-use client
   */
  public static async create(org: Org, apiVersion?: string): Promise<McnClient> {
    // eslint-disable-next-line sf-plugin/get-connection-with-version -- version resolved on the next line
    const probe = org.getConnection();
    const resolved = apiVersion ?? (await probe.retrieveMaxApiVersion());

    if (Number.parseFloat(resolved) < MIN_API_VERSION) {
      throw new SfError(
        `API version ${resolved} is too low. Marketing Cloud Next requires v${MIN_API_VERSION}.0 or later.`,
        'ApiVersionTooLowError',
        [`Re-run with --api-version ${MIN_API_VERSION}.0 or upgrade the org.`]
      );
    }

    return new McnClient(org.getConnection(resolved), resolved);
  }

  /**
   * Normalise the varied error shapes the platform returns into a single SfError.
   *
   * Marketing Cloud Next returns either a bare object or an array of
   * `{errorCode, message}` pairs depending on the endpoint family.
   *
   * @param error - the thrown value
   * @param method - HTTP method used
   * @param url - URL that was requested
   * @returns a normalised SfError
   */
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

  /**
   * Issue a single request and return the parsed body.
   *
   * @param options - request definition
   * @returns the parsed response body
   */
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

  /**
   * Follow every page of a paginated endpoint and return the concatenated items.
   *
   * Handles all three conventions: Connect API `items` + `nextPageUrl`, Data 360
   * `data` + `limit`/`offset`, and SOQL `records` + `nextRecordsUrl`.
   *
   * @param options - request definition for the first page
   * @param [pageSize] - page size for offset-based endpoints
   * @returns every item across all pages
   */
  public async requestAll<T>(options: RequestOptions, pageSize = 200): Promise<T[]> {
    const collected: T[] = [];
    let next: string | undefined;
    let offset = 0;

    for (;;) {
      /* eslint-disable no-await-in-loop -- pagination is sequential: each page's cursor comes from the previous response */
      const page: PagedEnvelope<T> = next
        ? await this.requestAbsolute<PagedEnvelope<T>>(next)
        : await this.request<PagedEnvelope<T>>({
            ...options,
            query: { limit: pageSize, offset, ...options.query },
          });
      /* eslint-enable no-await-in-loop */

      const batch = page.items ?? page.data ?? page.records ?? [];
      collected.push(...batch);

      // Connect API and SOQL hand back an explicit pointer to the next page.
      const pointer = page.nextPageUrl ?? page.nextPageUri ?? page.nextRecordsUrl;
      if (pointer) {
        next = pointer;
        continue;
      }

      // Data 360 endpoints have no pointer - walk the offset until a short page arrives.
      const usesOffset = page.data !== undefined && pointer === undefined;
      if (usesOffset && batch.length === pageSize) {
        offset += pageSize;
        next = undefined;
        continue;
      }

      return collected;
    }
  }

  /**
   * Request an already-absolute URL, used to follow pagination pointers.
   *
   * @param url - absolute or org-relative URL returned by a previous page
   * @returns the parsed response body
   */
  private async requestAbsolute<T>(url: string): Promise<T> {
    try {
      return await this.connection.request<T>({ method: 'GET', url });
    } catch (error) {
      throw McnClient.toSfError(error, 'GET', url);
    }
  }

  /**
   * Compose the full request URL including the pinned API version and query string.
   *
   * @param path - path relative to the versioned data endpoint
   * @param [query] - query parameters; `undefined` values are omitted
   * @returns the composed URL
   */
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

    const qs = search.toString();
    return qs ? `${base}?${qs}` : base;
  }
}
