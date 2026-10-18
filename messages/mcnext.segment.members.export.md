# summary

Export computed members of a Marketing Cloud Next segment.

# description

Resolves a segment by API name, MarketSegment record ID, or exact display name, then exports its computed members. Basic mode preserves the verified v67 SSOT members endpoint shape. With `--include-details`, the command discovers the segment's latest membership DMO and segment-on DMO, queries Data 360, and writes the segment-on DMO fields in service metadata order, one row per membership.

When the same display name exists in more than one data space, pass `--data-space` or the MarketSegment Id from the browser URL. In an interactive terminal (not `--json`), the command can prompt you to pick among matches when `--data-space` is omitted. If multiple candidates still match an explicit data space, the command fails with their Ids instead of prompting. Duplicate API names with unavailable data spaces require the Id from the browser URL.

Enriched mode resolves the Data 360 data space from `--data-space` when provided, otherwise from the segment's `dataSpace`, and fails closed if neither is available. Enriched queries filter the shared membership DMO's `Segment_Id__c` to the resolved MarketSegment ID before joining details or limiting output. Enriched mode applies `--limit` to the initial Query API request and each subsequent row page. It follows the query ID returned in `status.queryId` and offsets through the full SQL result, including results larger than 1,000 rows, subject to the configured item, page, and time bounds.

When `--output-file` is omitted, the command writes a collision-safe `<segment-name>-<timestamp>.csv|json` file under `./data/<data-space>/`, using the resolved segment data space after disambiguation (failing closed if that space is missing or unsafe as a directory name). Explicit `--output-file` paths are unchanged.

CSV and JSON outputs are staged beside the destination and replace it only after discovery, querying, paging, formatting, closing, commit, and backup cleanup all succeed. Existing destination bytes are normally restored on failure. If restoration is impossible, the error states the destination status and exact sibling backup path retaining the original. `--fields`, `--filters`, `--order-by`, and nonzero `--offset` are basic-only and are rejected with `--include-details`.

# examples

- Export basic members by segment API name as CSV using the configured default org:

  <%= config.bin %> <%= command.id %> --segment My_Published_Segment --output-file members.csv

- Export enriched Unified Individual details as JSON; data space can be inferred from the segment when `--data-space` is omitted:

  <%= config.bin %> <%= command.id %> --target-org my-org --segment My_Published_Segment --output-file member-details.json --result-format json --include-details --data-space Marketing

- Select a segment by MarketSegment ID and export basic JSON with verified request options:

  <%= config.bin %> <%= command.id %> --target-org my-org --segment 1sg000000000001 --output-file members.json --result-format json --fields Id**c,Delta_Type**c --filters "Delta_Type**c in ('new')" --order-by "Id**c asc" --limit 100

# flags.target-org.summary

Username or alias of the Marketing Cloud Next org. Not required if the `target-org` configuration variable is already set.

# flags.segment.summary

Segment API name, MarketSegment record ID, or exact segment display name.

# flags.output-file.summary

Optional destination file for exported member rows. When omitted, writes `./data/<data-space>/<segment-name>-<timestamp>.csv|json` using the resolved segment data space. Existing explicit destination bytes are normally restored on failure; exceptional restoration failure reports the exact retained backup path.

# flags.result-format.summary

Write member rows as CSV or JSON.

# flags.column-headers.summary

Use field labels or API names as enriched CSV and JSON keys. Labels are the default; empty labels fall back to API names and duplicates receive stable numeric suffixes.

# flags.include-details.summary

Query Data 360 and export details-only fields from the segment-on DMO discovered for the segment. Default: false.

# flags.data-space.summary

Data 360 data space used to disambiguate segment selection and, for enriched exports, as the Data-Space header. When omitted for `--include-details`, the segment's dataSpace is used.

# flags.fields.summary

Comma-separated SSOT storage fields requested from the basic members endpoint.

# flags.filters.summary

Filter expression passed to the basic members endpoint.

# flags.order-by.summary

Ordering expression passed to the basic members endpoint.

# flags.limit.summary

Basic mode page size; enriched mode Query API row page size.

# flags.offset.summary

Zero-based member offset for the first basic-mode page.

# flags.max-pages.summary

Maximum number of pages staged before failing, before destination replacement begins.

# flags.max-items.summary

Maximum exported rows. Basic mode stops at this count; enriched mode applies it as the SQL result limit and fails if the returned rows exceed it.

# flags.max-duration-ms.summary

Maximum paging duration in milliseconds before failing, before destination replacement begins.

# flags.column-delimiter.summary

Delimiter used for CSV output.

# flags.line-ending.summary

Line ending used for CSV output.

# flags.api-version.summary

MCN API version. This command currently accepts only the verified v67.0 baseline.
