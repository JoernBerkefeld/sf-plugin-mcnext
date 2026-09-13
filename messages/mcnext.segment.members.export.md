# summary

Export computed members of a Marketing Cloud Next segment.

# description

Resolves a segment by API name, MarketSegment record ID, or exact display name, then exports its computed members through the verified v67 SSOT members endpoint.

Rows are written incrementally as CSV or JSON. The API member `id` is preserved bytes-for-value and is Watson/SSOT membership data, not a claimed Salesforce CRM record ID. If a paging safety limit or request error stops the operation, the command reports that the partially written file is incomplete.

# examples

- Export members by segment API name as CSV:

  <%= config.bin %> <%= command.id %> --target-org my-org --segment Annual_Promo_Segment_1789248847753 --output-file members.csv

- Select a segment by MarketSegment ID and export JSON with verified request options:

  <%= config.bin %> <%= command.id %> --target-org my-org --segment 1sg000000000001 --output-file members.json --result-format json --fields Id__c,Delta_Type__c --filters "Delta_Type__c in ('new')" --order-by "Id__c asc" --limit 100

# flags.target-org.summary

Username or alias of the Marketing Cloud Next org.

# flags.segment.summary

Segment API name, MarketSegment record ID, or exact segment display name.

# flags.output-file.summary

Destination file for exported member rows.

# flags.result-format.summary

Write member rows as CSV or JSON.

# flags.fields.summary

Comma-separated SSOT storage fields requested from the members endpoint.

# flags.filters.summary

Filter expression passed to the members endpoint.

# flags.order-by.summary

Ordering expression passed to the members endpoint.

# flags.limit.summary

Number of member rows requested per page.

# flags.offset.summary

Zero-based member offset for the first page.

# flags.max-pages.summary

Maximum number of pages written before stopping with an incomplete-export error.

# flags.max-items.summary

Maximum number of rows written before stopping with an incomplete-export error.

# flags.max-duration-ms.summary

Maximum paging duration in milliseconds before stopping with an incomplete-export error.

# flags.column-delimiter.summary

Delimiter used for CSV output.

# flags.line-ending.summary

Line ending used for CSV output.

# flags.api-version.summary

MCN API version. This command currently accepts only the verified v67.0 baseline.
