# summary

Export computed members of a Marketing Cloud Next segment.

# description

Resolves a segment by API name, MarketSegment record ID, or exact display name, then exports its computed members. Basic mode preserves the verified v67 SSOT members endpoint shape. With `--include-details`, the command discovers the segment's latest membership DMO and segment-on DMO, queries Data 360, and writes exactly the 19 Unified Individual fields in service metadata order, one row per membership.

CSV and JSON outputs are staged beside the destination and replace it only after discovery, querying, paging, formatting, closing, commit, and backup cleanup all succeed. Existing destination bytes are normally restored on failure. If restoration is impossible, the error states the destination status and exact sibling backup path retaining the original. `--fields`, `--filters`, `--order-by`, and nonzero `--offset` are basic-only and are rejected with `--include-details`.

# examples

- Export basic members by segment API name as CSV using the configured default org:

  <%= config.bin %> <%= command.id %> --segment My_Published_Segment --output-file members.csv

- Export 19-field Unified Individual details as JSON from a named data space:

  <%= config.bin %> <%= command.id %> --target-org my-org --segment My_Published_Segment --output-file member-details.json --result-format json --include-details --data-space Marketing

- Select a segment by MarketSegment ID and export basic JSON with verified request options:

  <%= config.bin %> <%= command.id %> --target-org my-org --segment 1sg000000000001 --output-file members.json --result-format json --fields Id**c,Delta_Type**c --filters "Delta_Type**c in ('new')" --order-by "Id**c asc" --limit 100

# flags.target-org.summary

Username or alias of the Marketing Cloud Next org. Not required if the `target-org` configuration variable is already set.

# flags.segment.summary

Segment API name, MarketSegment record ID, or exact segment display name.

# flags.output-file.summary

Optional destination file for exported member rows. When omitted, a collision-safe absolute filename is generated from the segment name and local timestamp. Existing explicit destination bytes are normally restored on failure; exceptional restoration failure reports the exact retained backup path.

# flags.result-format.summary

Write member rows as CSV or JSON.

# flags.column-headers.summary

Use field labels or API names as enriched CSV and JSON keys. Labels are the default; empty labels fall back to API names and duplicates receive stable numeric suffixes.

# flags.include-details.summary

Query Data 360 and export the details-only 19-field Unified Individual contract. Default: false.

# flags.data-space.summary

Data 360 data space used by enriched metadata and Query API requests. Default: default.

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

Maximum number of rows staged before failing, before destination replacement begins.

# flags.max-duration-ms.summary

Maximum paging duration in milliseconds before failing, before destination replacement begins.

# flags.column-delimiter.summary

Delimiter used for CSV output.

# flags.line-ending.summary

Line ending used for CSV output.

# flags.api-version.summary

MCN API version. This command currently accepts only the verified v67.0 baseline.
